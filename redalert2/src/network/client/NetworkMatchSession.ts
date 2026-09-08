import { EventDispatcher } from '@/util/event';
import type { LanLaunchDescriptor } from '@/network/lan/LanRoomSession';
import type { LanMatchSnapshotState, LanResolvedTurn } from '@/network/lan/LanMatchSession';
import { decodePacket, encodeOrderPacket, encodeSyncPacket, type RelayedSyncPacket, type ServerMessage, type StartGameMessage } from '@/network/server/Protocol';
import { WebSocketConnection } from './WebSocketConnection';

/** Server-authoritative frame buffer. Wire frame 1 corresponds to simulation tick 0. */
export class NetworkMatchSession {
    readonly onMatchEnded = new EventDispatcher<this, Extract<ServerMessage, { type: 'matchEnded' }>>();
    readonly onReturnToLobby = new EventDispatcher<this, 'finished' | 'forfeit'>();
    readonly onChat = new EventDispatcher<this, Extract<ServerMessage, { type: 'chat' }>>();
    readonly onSnapshotChange = new EventDispatcher<this, LanMatchSnapshotState>();
    readonly onActionsReceived = new EventDispatcher<this, string>();
    readonly onFatalError = new EventDispatcher<this, { message: string; frame?: number }>();
    private readonly frames = new Map<number, Map<string, Uint8Array>>();
    private readonly aiTakeovers = new Set<string>();
    matchHealth: Extract<ServerMessage, { type: 'matchHealth' }>['players'] = [];
    private healthReceivedAt?: number;
    controlError?: string;
    private readonly drops = new Map<string, number>();
    private readonly loaded = new Map<string, number>();
    private readonly submitted = new Map<number, string>();
    private readonly active: Set<string>;
    private readonly syncs = new Map<number, { local?: string; relayed: Map<string, string> }>();
    private readonly lastRelayedSync = new Map<string, number>();
    private lastLocalSync = 0;
    private lastConsumedFrame = 0;
    private allLoaded = false;
    private observerLoaded = false;
    private historyNextFrame = 1;
    private historyPending?: number;
    private historyTimer?: ReturnType<typeof setTimeout>;
    private liveFrame = 0;
    private readonly agreedSyncs = new Map<number, string>();
    private disposed = false;
    private leftRoom = false;
    private returnedToLobby = false;
    fatalError?: { message: string; frame?: number };
    matchEnded?: Extract<ServerMessage, { type: 'matchEnded' }>;

    constructor(readonly connection: WebSocketConnection, readonly start: StartGameMessage, readonly descriptor: LanLaunchDescriptor) {
        if (start.netFrameInterval !== 1) throw new Error('Unsupported network frame interval.');
        this.liveFrame = start.liveFrame ?? 0;
        this.active = new Set(start.clientIds.map(String));
        this.connection.onMessage.subscribe(this.receive);
        this.connection.onClose.subscribe(this.closed);
    }

    getLaunchDescriptor(): LanLaunchDescriptor { return this.descriptor; }
    getHumanAssignment(peerId: string) { return this.descriptor.humanAssignments.find(item => item.peerId === peerId); }
    isObserver(): boolean { return this.start.observer === true; }
    getCatchupProgress(): { frame: number; liveFrame: number } { return { frame: this.lastConsumedFrame, liveFrame: this.liveFrame }; }
    isCatchingUp(): boolean { return this.isObserver() && this.liveFrame - this.lastConsumedFrame > 2; }
    notifyMatchEnded(message: Extract<ServerMessage, { type: 'matchEnded' }>): void { this.matchEnded = message; this.onMatchEnded.dispatch(this, message); }
    isHost(): boolean { return this.descriptor.localPeerId === this.descriptor.hostPeerId; }
    kickToAi(clientId: number): void {
        this.controlError = undefined;
        if (this.isHost()) this.send(() => this.connection.sendImmediate({ type: 'command', name: 'kick_ai', args: { clientId, gameId: this.start.gameId, generation: this.start.generation } }));
    }
    takesOverWithAi(peerId: string): boolean { return this.aiTakeovers.has(peerId); }
    areAllPlayersLoaded(): boolean { return this.allLoaded && (!this.isObserver() || (this.observerLoaded && (this.lastConsumedFrame > 0 || this.frames.has(1)))); }
    sendChat(to: 'all' | 'team' | 'observers' | number, text: string): void {
        this.send(() => this.connection.sendImmediate({ type: 'chat', to, text }));
    }
    reportLoadProgress(percent: number): void {
        if (this.isObserver()) { if (percent >= 100) { this.observerLoaded = true; this.requestHistory(); } return; }
        this.send(() => this.connection.sendImmediate({ type: 'loaded', gameId: this.start.gameId, generation: this.start.generation, percent: Math.max(0, Math.min(100, Math.floor(percent))) }));
    }
    submitLocalTurn(tick: number, actions: Uint8Array): string | undefined {
        if (this.isObserver()) return;
        if (this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        const frame = tick + 1;
        const existing = this.submitted.get(frame);
        if (existing) return existing;
        const id = `${this.descriptor.localPeerId}:${frame}`;
        const packet = encodeOrderPacket(Number(this.descriptor.localPeerId), frame, actions, this.start.generation);
        if (!this.send(() => this.connection.sendRaw(packet))) return;
        this.submitted.set(frame, id);
        return id;
    }
    sendSync(tick: number, hash: number, defeatMask = 0n): void {
        if (this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        const frame = tick + 1;
        if (this.isObserver()) {
            if (frame !== this.lastLocalSync + 1 || frame !== this.lastConsumedFrame) { this.fail('Invalid observer sync sequence.', frame); return; }
            this.lastLocalSync = frame;
            if (this.agreedSyncs.get(frame) !== `${hash >>> 0}:${BigInt.asUintN(64, defeatMask)}`) this.fail(`Game out of sync at frame ${frame}.`, frame);
            this.agreedSyncs.delete(frame);
            return;
        }
        const packet = encodeSyncPacket(frame, hash, defeatMask, this.start.generation);
        // Compare the wire-normalized local value, independently of the server's echo.
        const value = `${hash >>> 0}:${BigInt.asUintN(64, defeatMask)}`;
        if (frame !== this.lastLocalSync + 1) { this.fail('Invalid local sync sequence.', frame); return; }
        this.lastLocalSync = frame;
        const reports = this.getSyncReports(frame);
        if (!reports) return;
        reports.local = value;
        // Send evidence before notifying listeners: fatal-error handlers may close the session.
        if (this.send(() => this.connection.sendRaw(packet))) this.checkSync(frame, reports);
    }
    tryConsumeTurn(tick: number): LanResolvedTurn | undefined {
        if (!this.allLoaded || this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        const frame = tick + 1;
        if (this.isObserver() && (frame !== this.lastConsumedFrame + 1 || this.lastLocalSync !== this.lastConsumedFrame || !this.frames.has(frame))) return;
        const drops = [...this.drops].filter(([id, at]) => at <= frame && this.active.has(id)).map(([id]) => id);
        const expected = this.descriptor.humanAssignments.map(item => item.peerId).filter(id => this.active.has(id) && !drops.includes(id));
        const packets = this.frames.get(frame);
        if (expected.some(id => !packets?.has(id))) return;
        this.frames.delete(frame);
        this.lastConsumedFrame = frame;
        drops.forEach(id => this.active.delete(id));
        if (this.isObserver()) this.scheduleHistory(0);
        const submittedAt = frame - this.start.orderLatency;
        const id = this.submitted.get(submittedAt);
        if (id) { this.submitted.delete(submittedAt); this.onActionsReceived.dispatch(this, id); }
        return { tick, controlPeerId: this.descriptor.hostPeerId, dropPeerIds: drops, batches: expected.map(peerId => ({
            tick, peerId, turnId: `${peerId}:${frame}`, actionData: packets!.get(peerId)!, dropPeerIds: [], receivedAt: 0,
        })) };
    }
    /** Bounded local evidence; missing relayed batches do not identify the cause of delay. */
    getPerformanceSnapshot(waitingTick?: number) {
        const frame = waitingTick === undefined ? undefined : waitingTick + 1;
        const expected = frame === undefined ? [] : this.descriptor.humanAssignments
            .filter(({ peerId }) => this.active.has(peerId) && (this.drops.get(peerId) ?? Infinity) > frame)
            .map(({ peerId }) => peerId);
        const packets = frame === undefined ? undefined : this.frames.get(frame);
        return {
            role: this.isObserver() ? 'observer' : 'commander',
            localPeerId: this.descriptor.localPeerId,
            waitingTick: waitingTick ?? null,
            waitingWireFrame: frame ?? null,
            missingPeerIds: expected.filter(id => !packets?.has(id)).slice(0, 16),
            receivedPeerIds: expected.filter(id => packets?.has(id)).slice(0, 16),
            peerDetailsTruncated: expected.length > 16 || this.matchHealth.length > 16,
            activePeerCount: this.active.size,
            bufferedFrameCount: this.frames.size,
            pendingLocalTurnCount: this.submitted.size,
            lastConsumedFrame: this.lastConsumedFrame,
            configuredOrderLatencyFrames: this.start.orderLatency,
            allPeersLoaded: this.areAllPlayersLoaded(),
            observerHistoryPendingFrame: this.historyPending ?? null,
            observerLiveFrame: this.isObserver() ? this.liveFrame : null,
            transport: this.connection.getPerformanceSnapshot?.() ?? null,
            // These server measurements are currently broadcast only to the host.
            serverHealthAgeMs: this.healthReceivedAt === undefined ? null : Math.max(0, Date.now() - this.healthReceivedAt),
            serverReportedPeers: this.matchHealth.slice(0, 16).map(peer => ({
                peerId: String(peer.clientId), serverRoundTripMs: peer.ping, serverProgressLagMs: peer.lagMs,
            })),
        };
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
        clearTimeout(this.historyTimer);
        this.fatalError = { message, frame };
        this.onFatalError.dispatch(this, this.fatalError);
    }
    private scheduleHistory(delay: number): void {
        if (this.historyTimer || this.historyPending !== undefined || !this.observerLoaded || this.frames.size > 16 || this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        this.historyTimer = setTimeout(() => { this.historyTimer = undefined; this.requestHistory(); }, Math.max(10, delay));
    }
    private requestHistory(): void {
        if (this.historyPending !== undefined || this.frames.size > 16 || this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        this.historyPending = this.historyNextFrame;
        this.send(() => this.connection.sendImmediate({ type: 'history', gameId: this.start.gameId, generation: this.start.generation,
            observationId: this.start.observationId!, fromFrame: this.historyNextFrame, maxFrames: 32 }));
    }
    private receiveHistory(message: Extract<ServerMessage, {type: 'history'}>): void {
        if (!this.isObserver() || message.gameId !== this.start.gameId || message.generation !== this.start.generation || message.observationId !== this.start.observationId) return;
        if (message.fromFrame !== this.historyPending) return;
        this.historyPending = undefined;
        if (message.frames.length > 32 || this.frames.size + message.frames.length > 64 || !Number.isSafeInteger(message.liveFrame) || message.liveFrame < this.liveFrame) throw new Error('Invalid observer history window.');
        this.liveFrame = message.liveFrame;
        this.allLoaded = message.allLoaded;
        for (const entry of message.frames) {
            if (entry.frame !== this.historyNextFrame || entry.frame > this.liveFrame || !Number.isInteger(entry.hash) || entry.hash < 0 || entry.hash > 0xffffffff || typeof entry.defeatMask !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(entry.defeatMask) || BigInt(entry.defeatMask) > 0xffffffffffffffffn) throw new Error('Invalid observer history sequence.');
            const packets = new Map<string, Uint8Array>();
            for (const order of entry.orders) {
                if (!this.start.clientIds.includes(order.clientId) || packets.has(String(order.clientId))) throw new Error('Invalid observer order roster.');
                if (typeof order.actions !== 'string' || order.actions.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(order.actions)) throw new Error('Invalid observer actions.');
                const actions = Uint8Array.from(atob(order.actions), char => char.charCodeAt(0));
                packets.set(String(order.clientId), actions);
            }
            for (const drop of entry.drops) {
                if (!this.start.clientIds.includes(drop.clientId) || drop.frame !== entry.frame || this.drops.has(String(drop.clientId))) throw new Error('Invalid observer drop.');
                this.drops.set(String(drop.clientId), drop.frame);
                if (drop.takeover === 'ai') this.aiTakeovers.add(String(drop.clientId));
            }
            const expected = this.start.clientIds.filter(id => (this.drops.get(String(id)) ?? Infinity) > entry.frame);
            if (packets.size !== expected.length || expected.some(id => !packets.has(String(id)))) throw new Error('Incomplete observer frame.');
            this.frames.set(entry.frame, packets);
            this.agreedSyncs.set(entry.frame, `${entry.hash >>> 0}:${BigInt.asUintN(64, BigInt(entry.defeatMask))}`);
            this.historyNextFrame++;
        }
        this.scheduleHistory(message.frames.length ? 0 : 100);
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
    private send(write: () => void): boolean {
        if (this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return false;
        try { write(); return true; }
        catch (error) {
            this.fail(`Connection to the game server was lost. ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    private readonly closed = (reason: string) => {
        if (!this.leftRoom && !this.disposed && !this.returnedToLobby) this.fail(reason);
    };
    private readonly receive = (data: string | Uint8Array) => {
        if (this.fatalError || this.disposed || this.leftRoom || this.returnedToLobby) return;
        try {
            if (typeof data !== 'string') {
                if (this.isObserver()) return;
                const packet = decodePacket(data);
                if (packet.generation !== this.start.generation) return;
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
                if (['loaded', 'allLoaded', 'ack', 'disconnect', 'matchHealth', 'outOfSync', 'matchEnded'].includes(message.type)
                    && (!('generation' in message) || message.generation !== this.start.generation)) return;
                if (message.type === 'history') { if (data.length > 65536) throw new Error('Observer history packet too large.'); this.receiveHistory(message); this.onSnapshotChange.dispatch(this, this.getSnapshot()); return; }
                if (this.isObserver() && ['loaded', 'allLoaded', 'disconnect'].includes(message.type)) return;
                if (message.type === 'matchHealth') { this.matchHealth = message.players; this.healthReceivedAt = Date.now(); return; }
                if (message.type === 'error' && message.code === 'invalidCommand') { this.controlError = message.message; return; }
                if (message.type === 'chat') { this.onChat.dispatch(this, message); return; }
                if (message.type === 'loaded') this.loaded.set(String(message.clientId), message.percent);
                else if (message.type === 'allLoaded') this.allLoaded = true;
                else if (message.type === 'disconnect') {
                    if (message.frame <= this.lastConsumedFrame) throw new Error('Server sent a late player disconnect.');
                    this.drops.set(String(message.clientId), message.frame);
                    if (message.takeover === 'ai') this.aiTakeovers.add(String(message.clientId));
                    for (const [frame, reports] of this.syncs) this.checkSync(frame, reports);
                } else if (message.type === 'outOfSync') this.fail(`Game out of sync at frame ${message.frame}.`, message.frame);
            }
            this.onSnapshotChange.dispatch(this, this.getSnapshot());
        } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    };
    /** Stop this commander without closing the room connection, including during game.update(). */
    returnToLobby(reason: 'finished' | 'forfeit'): void {
        if (this.returnedToLobby || this.leftRoom) return;
        // Disposal may precede the screen's return callback. This room control must still be sent.
        this.returnedToLobby = true;
        clearTimeout(this.historyTimer);
        try {
            this.connection.sendImmediate({ type: 'returnToLobby', gameId: this.start.gameId, generation: this.start.generation, reason, ...(this.isObserver() ? { observationId: this.start.observationId } : {}) });
        } catch (error) {
            this.fail(`Connection to the game server was lost. ${error instanceof Error ? error.message : String(error)}`);
        }
        this.onReturnToLobby.dispatch(this, reason);
    }
    leaveRoom(): void { clearTimeout(this.historyTimer); this.leftRoom = true; this.connection.close(); }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.historyTimer); this.agreedSyncs.clear();
        this.connection.onMessage.unsubscribe(this.receive);
        this.connection.onClose.unsubscribe(this.closed);
        this.frames.clear(); this.submitted.clear(); this.syncs.clear(); this.lastRelayedSync.clear();
    }
}
