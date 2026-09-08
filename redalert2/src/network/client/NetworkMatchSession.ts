import { EventDispatcher } from '@/util/event';
import type { LanLaunchDescriptor } from '@/network/lan/LanRoomSession';
import type { LanMatchSnapshotState, LanResolvedTurn } from '@/network/lan/LanMatchSession';
import { decodePacket, encodeOrderPacket, encodeSyncPacket, type RelayedSyncPacket, type ServerMessage, type StartGameMessage } from '@/network/server/Protocol';
import { WebSocketConnection } from './WebSocketConnection';

/** Server-authoritative frame buffer. Wire frame 1 corresponds to simulation tick 0. */
export class NetworkMatchSession {
    readonly onSnapshotChange = new EventDispatcher<this, LanMatchSnapshotState>();
    readonly onActionsReceived = new EventDispatcher<this, string>();
    readonly onFatalError = new EventDispatcher<this, { message: string; frame?: number }>();
    private readonly frames = new Map<number, Map<string, Uint8Array>>();
    private readonly drops = new Map<string, number>();
    private readonly loaded = new Map<string, number>();
    private readonly submitted = new Map<number, string>();
    private readonly active: Set<string>;
    private readonly syncs = new Map<number, { local?: string; relayed: Map<string, string> }>();
    private readonly lastRelayedSync = new Map<string, number>();
    private lastLocalSync = 0;
    private lastConsumedFrame = 0;
    private allLoaded = false;
    private disposed = false;
    fatalError?: { message: string; frame?: number };

    constructor(readonly connection: WebSocketConnection, readonly start: StartGameMessage, readonly descriptor: LanLaunchDescriptor) {
        if (start.netFrameInterval !== 1) throw new Error('Unsupported network frame interval.');
        this.active = new Set(start.clientIds.map(String));
        this.connection.onMessage.subscribe(this.receive);
        this.connection.onClose.subscribe(this.closed);
    }

    getLaunchDescriptor(): LanLaunchDescriptor { return this.descriptor; }
    getHumanAssignment(peerId: string) { return this.descriptor.humanAssignments.find(item => item.peerId === peerId); }
    areAllPlayersLoaded(): boolean { return this.allLoaded; }
    reportLoadProgress(percent: number): void {
        this.connection.sendImmediate({ type: 'loaded', percent: Math.max(0, Math.min(100, Math.floor(percent))) });
    }
    submitLocalTurn(tick: number, actions: Uint8Array): string {
        const frame = tick + 1;
        const existing = this.submitted.get(frame);
        if (existing) return existing;
        const id = `${this.descriptor.localPeerId}:${frame}`;
        this.submitted.set(frame, id);
        this.connection.sendRaw(encodeOrderPacket(Number(this.descriptor.localPeerId), frame, actions));
        return id;
    }
    sendSync(tick: number, hash: number, defeatMask = 0n): void {
        if (this.fatalError || this.disposed) return;
        const frame = tick + 1;
        const packet = encodeSyncPacket(frame, hash, defeatMask);
        // Compare the wire-normalized local value, independently of the server's echo.
        const value = `${hash >>> 0}:${BigInt.asUintN(64, defeatMask)}`;
        if (frame !== this.lastLocalSync + 1) { this.fail('Invalid local sync sequence.', frame); return; }
        this.lastLocalSync = frame;
        const reports = this.getSyncReports(frame);
        if (!reports) return;
        reports.local = value;
        this.checkSync(frame, reports);
        // Still send a newly detected mismatch so other clients receive our evidence.
        this.connection.sendRaw(packet);
    }
    tryConsumeTurn(tick: number): LanResolvedTurn | undefined {
        if (!this.allLoaded || this.fatalError) return;
        const frame = tick + 1;
        const drops = [...this.drops].filter(([id, at]) => at <= frame && this.active.has(id)).map(([id]) => id);
        const expected = this.descriptor.humanAssignments.map(item => item.peerId).filter(id => this.active.has(id) && !drops.includes(id));
        const packets = this.frames.get(frame);
        if (expected.some(id => !packets?.has(id))) return;
        this.frames.delete(frame);
        this.lastConsumedFrame = frame;
        drops.forEach(id => this.active.delete(id));
        const submittedAt = frame - this.start.orderLatency;
        const id = this.submitted.get(submittedAt);
        if (id) { this.submitted.delete(submittedAt); this.onActionsReceived.dispatch(this, id); }
        return { tick, controlPeerId: this.descriptor.hostPeerId, dropPeerIds: drops, batches: expected.map(peerId => ({
            tick, peerId, turnId: `${peerId}:${frame}`, actionData: packets!.get(peerId)!, dropPeerIds: [], receivedAt: 0,
        })) };
    }
    getSnapshot(): LanMatchSnapshotState {
        return {
            gameId: this.descriptor.gameId, localPeerId: this.descriptor.localPeerId, controlPeerId: this.descriptor.hostPeerId,
            activePeerIds: [...this.active], suspectedDropPeerIds: [...this.drops.keys()],
            bufferedTicks: [...this.frames.keys()].map(frame => frame - 1),
            batchPeerIdsByTick: Object.fromEntries([...this.frames].map(([frame, packets]) => [frame - 1, [...packets.keys()]])),
            pendingLocalTicks: [...this.submitted.keys()].map(frame => frame - 1), allPeersLoaded: this.allLoaded,
            loadPercentByPeerId: Object.fromEntries(this.loaded),
            transportMembers: this.descriptor.humanAssignments.map(({ peerId }) => ({ id: peerId, isSelf: peerId === this.descriptor.localPeerId, status: this.active.has(peerId) ? 'connected' : 'known' })),
        };
    }
    fail(message: string, frame?: number): void {
        if (this.fatalError) return;
        this.fatalError = { message, frame };
        this.onFatalError.dispatch(this, this.fatalError);
    }
    private getSyncReports(frame: number) {
        let reports = this.syncs.get(frame);
        if (!reports) {
            if (this.syncs.size >= 512) { this.fail('Too many pending sync frames.', frame); return; }
            this.syncs.set(frame, reports = { relayed: new Map() });
        }
        return reports;
    }
    private checkSync(frame: number, reports: { local?: string; relayed: Map<string, string> }): void {
        const values = [...reports.relayed.values()];
        if (reports.local !== undefined) values.push(reports.local);
        if (new Set(values).size > 1) { this.fail(`Game out of sync at frame ${frame}.`, frame); return; }
        // A disconnected client cannot supply any more reports, even for its queued orders.
        if (reports.local !== undefined && this.start.clientIds.every(id => this.drops.has(String(id)) || reports.relayed.has(String(id)))) {
            this.syncs.delete(frame);
        }
    }
    private receiveSync(packet: RelayedSyncPacket): void {
        const id = String(packet.clientId);
        if (!this.start.clientIds.includes(packet.clientId) || this.drops.has(id)) throw new Error('Server sent sync for an unknown or disconnected player.');
        if (packet.frame !== (this.lastRelayedSync.get(id) ?? 0) + 1) throw new Error('Server sent an invalid sync sequence.');
        if (packet.frame > this.lastConsumedFrame + 256) throw new Error('Server sent sync too far ahead.');
        this.lastRelayedSync.set(id, packet.frame);
        const reports = this.getSyncReports(packet.frame);
        if (!reports) return;
        reports.relayed.set(id, `${packet.hash}:${packet.defeatMask}`);
        this.checkSync(packet.frame, reports);
    }
    private readonly closed = (reason: string) => this.fail(reason);
    private readonly receive = (data: string | Uint8Array) => {
        if (this.fatalError || this.disposed) return;
        try {
            if (typeof data !== 'string') {
                const packet = decodePacket(data);
                if (packet.kind === 'syncRelay') { this.receiveSync(packet); return; }
                if (packet.kind !== 'orders') throw new Error('Server sent an unstamped sync packet.');
                if (!this.active.has(String(packet.clientId)) || packet.frame <= this.lastConsumedFrame) return;
                if (packet.frame > this.lastConsumedFrame + 512) throw new Error('Server sent an order too far ahead.');
                let packets = this.frames.get(packet.frame);
                if (!packets) this.frames.set(packet.frame, packets = new Map());
                if (packets.has(String(packet.clientId))) throw new Error('Server sent a duplicate order frame.');
                packets.set(String(packet.clientId), packet.actions);
            } else {
                const message: ServerMessage = JSON.parse(data);
                if (message.type === 'loaded') this.loaded.set(String(message.clientId), message.percent);
                else if (message.type === 'allLoaded') this.allLoaded = true;
                else if (message.type === 'disconnect') {
                    if (message.frame <= this.lastConsumedFrame) throw new Error('Server sent a late player disconnect.');
                    this.drops.set(String(message.clientId), message.frame);
                    for (const [frame, reports] of this.syncs) this.checkSync(frame, reports);
                } else if (message.type === 'outOfSync') this.fail(`Game out of sync at frame ${message.frame}.`, message.frame);
            }
            this.onSnapshotChange.dispatch(this, this.getSnapshot());
        } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    };
    leaveRoom(): void { this.connection.close(); }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.connection.onMessage.unsubscribe(this.receive);
        this.connection.onClose.unsubscribe(this.closed);
        this.frames.clear(); this.submitted.clear(); this.syncs.clear(); this.lastRelayedSync.clear();
    }
}
