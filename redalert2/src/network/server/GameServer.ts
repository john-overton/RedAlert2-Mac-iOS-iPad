import type { GameOpts } from '../../game/gameopts/GameOpts';
import type { SlotInfo } from '../gameopt/SlotInfo';
import { decodePacket, encodeOrderPacket, encodeRelayedSyncPacket, HANDSHAKE_PROTOCOL, MAX_PACKET_BYTES, ORDERS_PROTOCOL } from './Protocol';
import type { HelloMessage, ProtocolIdentity, ServerMessage } from './Protocol';
import type { Session, SessionClient } from './Session';
import type { ServerConnection, ServerTransport, WireData } from './ServerTransport';

export interface GameServerOptions {
    identity: ProtocolIdentity;
    gameOpts: GameOpts;
    slotsInfo?: SlotInfo[];
    serverName?: string;
    password?: string;
    orderLatency?: number;
    netFrameInterval?: number;
    allowSpectators?: boolean;
    allowSinglePlayer?: boolean;
    countryCount?: number;
    dedicated?: boolean;
    now?: () => number;
    random?: () => number;
}
interface Peer {
    connection: ServerConnection;
    client?: SessionClient;
    connectedAt: number;
    lastSeen: number;
    lastPing: number;
    lastFrame: number;
    lastSync: number;
    floodAt: number;
    floodCount: number;
    warned: boolean;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const selection = (value: unknown, max: number): value is number => value === -2 || integer(value, 0, max);
const label = (value: unknown, limit = 32): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const scalarOptions: Record<string, [number, number] | 'boolean'> = {
    gameSpeed: [0, 6], credits: [0, 100000], unitCount: [0, 100], shortGame: 'boolean', superWeapons: 'boolean', buildOffAlly: 'boolean', mcvRepacks: 'boolean', cratesAppear: 'boolean', hostTeams: 'boolean', destroyableBridges: 'boolean', multiEngineer: 'boolean', noDogEngiKills: 'boolean',
};

/** Authoritative, runtime independent lobby and frame relay. Call tick every second. */
export class GameServer {
    private readonly peers = new Set<Peer>();
    private readonly model: Session;
    private readonly now: () => number;
    private readonly syncs = new Map<number, Map<number, string>>();
    private readonly active = new Set<number>();
    private nextId = 1;
    private allLoaded = false;
    private embeddedHostId?: number;
    private stopped = false;

    constructor(private readonly options: GameServerOptions, private readonly transport?: ServerTransport) {
        this.now = options.now ?? Date.now;
        const gameOpts = clone(options.gameOpts);
        if (options.countryCount !== undefined && !integer(options.countryCount, 1, 32)) throw new Error('Invalid country count');
        if (!integer(gameOpts.gameSpeed, 0, 6)) throw new Error('Invalid game speed');
        if (!integer(gameOpts.maxSlots, 1, 8)) throw new Error('Expected 1 to 8 player slots');
        const orderLatency = options.orderLatency ?? 2;
        const netFrameInterval = options.netFrameInterval ?? 1;
        if (!integer(orderLatency, 1, 12) || netFrameInterval !== 1) throw new Error('Invalid network timing');
        this.model = { state: 'waiting', serverName: options.serverName?.trim() || 'Red Alert 2', clients: [], slots: Array.from({ length: gameOpts.maxSlots }, (_, i) => {
            const slot = options.slotsInfo?.[i];
            // The host connects as an ordinary client, so saved human slots begin open.
            return slot?.type === 4 ? clone(slot) : { type: slot?.type === 0 ? 0 : 1 };
        }), gameOpts, orderLatency, netFrameInterval, allowSpectators: false };
        gameOpts.humanPlayers = [];
        gameOpts.aiPlayers = Array.from({ length: gameOpts.maxSlots }, (_, i) => this.model.slots[i].type === 4 ? gameOpts.aiPlayers[i] : undefined);
    }
    get isStopped(): boolean { return this.stopped; }
    private get countryMax(): number { return (this.options.countryCount ?? (this.options.identity.engine === 'yr' ? 10 : 9)) - 1; }
    get session(): Session { return clone(this.model); }
    start(): void | Promise<void> { return this.transport?.listen(connection => this.accept(connection)); }
    accept(connection: ServerConnection): void {
        if (this.stopped || this.peers.size >= 24) { connection.close('Server unavailable'); return; }
        const now = this.now();
        const peer: Peer = { connection, connectedAt: now, lastSeen: now, lastPing: now, lastFrame: 0, lastSync: 0, floodAt: now, floodCount: 0, warned: false };
        this.peers.add(peer);
        connection.onMessage(data => this.receive(peer, data));
        connection.onClose(() => this.drop(peer));
    }
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.model.state = 'ended';
        this.broadcast({ type: 'message', key: 'serverClosed' });
        for (const peer of [...this.peers]) { this.peers.delete(peer); peer.connection.close('Server closed'); }
        this.transport?.close();
    }
    tick(now = this.now()): void {
        for (const peer of [...this.peers]) {
            if ((!peer.client && now - peer.connectedAt >= 10000) || now - peer.lastSeen >= 60000) { this.reject(peer, 'timeout'); continue; }
            if (peer.client && now - peer.lastSeen >= 10000 && !peer.warned) {
                peer.warned = true;
                this.broadcast({ type: 'message', key: 'connectionProblems', args: { clientId: peer.client.id } });
            }
            if (peer.client && now - peer.lastPing >= 5000) { peer.lastPing = now; this.send(peer, { type: 'ping', t: now }); }
        }
    }
    private send(peer: Peer, message: ServerMessage | Uint8Array): void {
        try { peer.connection.send(message instanceof Uint8Array ? message : JSON.stringify(message)); }
        catch { this.drop(peer); }
    }
    private broadcast(message: ServerMessage | Uint8Array): void { for (const peer of [...this.peers]) if (peer.client) this.send(peer, message); }
    private syncLobby(): void { this.updatePlayers(); this.broadcast({ type: 'session', session: this.session }); }
    private updatePlayers(): void {
        this.model.gameOpts.humanPlayers = this.model.clients.filter(c => c.slotIndex !== null).sort((a, b) => a.slotIndex! - b.slotIndex!).map(c => ({ name: c.name, countryId: c.countryId, colorId: c.colorId, startPos: c.startPos, teamId: c.teamId }));
    }
    private reject(peer: Peer, code: string): void { this.send(peer, { type: 'error', code }); this.drop(peer); peer.connection.close(code); }
    private fail(peer: Peer, message: string): void { this.send(peer, { type: 'error', code: 'invalidCommand', message }); }
    private receive(peer: Peer, data: WireData): void {
        if (!this.peers.has(peer)) return;
        if (data.length > MAX_PACKET_BYTES || (typeof data === 'string' && data.length * 3 > MAX_PACKET_BYTES)) { this.reject(peer, 'packetTooLarge'); return; }
        try {
            if (typeof data !== 'string') {
                // Buffered frames may arrive after the first mismatch. Preserve that
                // diagnosis instead of turning normal in-flight traffic into a drop.
                if (peer.client && this.model.state === 'ended') return;
                if (!peer.client || this.model.state !== 'started' || !this.allLoaded) throw new Error('Unexpected orders');
                this.receivePacket(peer, data);
            } else {
                const message = JSON.parse(data);
                if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
                if (!peer.client) { if (message.type !== 'hello') throw new Error('Handshake required'); this.hello(peer, message); }
                else if (message.type === 'pong') { if (typeof message.t !== 'number' || message.t !== peer.lastPing) throw new Error('Invalid pong'); peer.client.ping = Math.max(0, this.now() - message.t); }
                else if (message.type === 'ping') { if (typeof message.t !== 'number' || !Number.isFinite(message.t)) throw new Error('Invalid ping'); this.send(peer, { type: 'pong', t: message.t }); }
                else if (message.type === 'loaded') this.loaded(peer, message.percent);
                else {
                    const now = this.now();
                    if (now - peer.floodAt >= 1000) { peer.floodAt = now; peer.floodCount = 0; }
                    if (++peer.floodCount > 30) { this.fail(peer, 'Please slow down'); return; }
                    if (message.type === 'command') this.command(peer, message.name, message.args ?? {});
                    else if (message.type === 'chat') this.chat(peer, message.to, message.text);
                    else throw new Error('Unknown message');
                }
            }
            peer.lastSeen = this.now(); peer.warned = false;
        } catch { this.reject(peer, 'invalidPacket'); }
    }
    private hello(peer: Peer, hello: HelloMessage): void {
        const expected = this.options.identity;
        let error: string | undefined;
        if (this.model.state !== 'waiting') error = 'gameStarted';
        else if (this.options.password && !hello.password) error = 'passwordRequired';
        else if (this.options.password && hello.password !== this.options.password) error = 'passwordWrong';
        else if (hello.mod !== expected.mod || hello.modHash !== expected.modHash || hello.engine !== expected.engine) error = 'modMismatch';
        else if (hello.version !== expected.version) error = 'versionMismatch';
        else if (hello.assetFingerprint !== expected.assetFingerprint) error = 'assetMismatch';
        else if (hello.protocol !== HANDSHAKE_PROTOCOL || hello.ordersProtocol !== ORDERS_PROTOCOL) error = 'protocolMismatch';
        else if (!label(hello.name) || this.model.clients.some(c => c.name.toLowerCase() === hello.name.trim().toLowerCase())) error = 'invalidName';
        const slot = this.model.slots.findIndex(s => s.type === 1);
        if (!error && slot < 0 && !this.model.allowSpectators) error = 'full';
        if (error) { this.reject(peer, error); return; }
        peer.client = { id: this.nextId++, name: hello.name.trim(), slotIndex: slot < 0 ? null : slot, countryId: selection(hello.preferredCountry, this.countryMax) ? hello.preferredCountry : -2, colorId: selection(hello.preferredColor, 7) ? hello.preferredColor : -2, startPos: -2, teamId: -2, admin: this.model.clients.length === 0, ready: false, mapReady: false, loaded: 0, ping: 0 };
        if (this.embeddedHostId === undefined && !this.options.dedicated) this.embeddedHostId = peer.client.id;
        this.model.clients.push(peer.client);
        if (slot >= 0) this.model.slots[slot] = { type: 3, name: peer.client.name };
        this.updatePlayers();
        this.send(peer, { type: 'welcome', clientId: peer.client.id, session: this.session });
        this.syncLobby();
    }
    private resetReady(): void { for (const client of this.model.clients) client.ready = false; }
    private command(peer: Peer, name: unknown, args: Record<string, unknown>): void {
        const client = peer.client!;
        if (this.model.state !== 'waiting') { this.fail(peer, 'The game has already started'); return; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) { this.fail(peer, 'Invalid arguments'); return; }
        if (name === 'sync_lobby') { this.send(peer, { type: 'session', session: this.session }); return; }
        if (client.ready && name !== 'state' && name !== 'ready' && name !== 'startgame') { this.fail(peer, 'Unready before changing the lobby'); return; }
        if (name === 'state' || name === 'ready') {
            if (args.mapDigest === this.model.gameOpts.mapDigest) client.mapReady = true;
            if (typeof args.ready !== 'boolean' || (args.ready && !client.mapReady)) { this.fail(peer, 'The selected map must be available before readying'); return; }
            client.ready = args.ready;
        } else if (name === 'map_ready') {
            client.mapReady = args.digest === this.model.gameOpts.mapDigest;
            if (!client.mapReady) client.ready = false;
        } else if (name === 'startgame') { this.startGame(peer); return; }
        else if (name === 'name') {
            if (!label(args.name) || this.model.clients.some(c => c !== client && c.name.toLowerCase() === (args.name as string).trim().toLowerCase())) { this.fail(peer, 'Choose a unique player name'); return; }
            client.name = args.name.trim();
            if (client.slotIndex !== null) this.model.slots[client.slotIndex].name = client.name;
        } else if (name === 'player') {
            const slot = args.slotIndex ?? client.slotIndex;
            if (!integer(slot, 0, this.model.slots.length - 1)) { this.fail(peer, 'Invalid slot'); return; }
            let target: SessionClient | NonNullable<GameOpts['aiPlayers'][number]> = client;
            if (slot !== client.slotIndex) {
                if (client.admin && this.model.slots[slot].type === 4) target = this.model.gameOpts.aiPlayers[slot]!;
                else if (this.model.slots[slot].type !== 1) { this.fail(peer, 'Slot is occupied'); return; }
            }
            for (const [key, min, max] of [['countryId', -2, this.countryMax], ['colorId', -2, 7], ['startPos', -2, this.model.slots.length - 1], ['teamId', -2, 3]] as const) {
                if (args[key] !== undefined && !selection(args[key], max)) { this.fail(peer, `Invalid ${key}`); return; }
            }
            if (typeof args.startPos === 'number' && args.startPos >= 0 && [...this.model.clients, ...this.model.gameOpts.aiPlayers.filter(Boolean)].some(c => c !== target && c!.startPos === args.startPos)) { this.fail(peer, 'Start position is occupied'); return; }
            if (target === client && slot !== client.slotIndex) {
                if (client.slotIndex !== null) this.model.slots[client.slotIndex] = { type: 1 };
                client.slotIndex = slot; this.model.slots[slot] = { type: 3, name: client.name };
            }
            for (const key of ['countryId', 'colorId', 'startPos', 'teamId'] as const) if (args[key] !== undefined) target[key] = args[key] as number;
            if (target !== client) this.resetReady();
        } else if (name === 'spectate') {
            if (!this.model.allowSpectators) { this.fail(peer, 'Spectators are disabled'); return; }
            if (client.slotIndex !== null) this.model.slots[client.slotIndex] = { type: 1 };
            client.slotIndex = null;
        } else {
            if (!client.admin) { this.fail(peer, 'Only the host can change this'); return; }
            if (name === 'option') {
                const range = scalarOptions[args.key as string];
                if (!range || (range === 'boolean' ? typeof args.value !== 'boolean' : !integer(args.value, ...range))) { this.fail(peer, 'Invalid game option'); return; }
                (this.model.gameOpts as unknown as Record<string, unknown>)[args.key as string] = args.value;
                this.resetReady();
            } else if (name === 'map') {
                const value = args.gameOpts as GameOpts | undefined;
                if (!value || !label(value.mapName, 256) || !label(value.mapDigest, 128) || !label(value.mapTitle, 256) || !integer(value.maxSlots, 1, 8) || !integer(value.gameMode, 0, 10000) || !integer(value.mapSizeBytes, 0, 32 * 1024 * 1024) || typeof value.mapOfficial !== 'boolean') { this.fail(peer, 'Invalid map'); return; }
                if (this.model.clients.some(c => c.slotIndex !== null && c.slotIndex >= value.maxSlots)) { this.fail(peer, 'Move players before choosing a smaller map'); return; }
                for (const key of ['mapName', 'mapDigest', 'mapTitle', 'maxSlots', 'gameMode', 'mapSizeBytes', 'mapOfficial'] as const) (this.model.gameOpts as any)[key] = value[key];
                this.model.slots = Array.from({ length: value.maxSlots }, (_, i) => this.model.slots[i] ?? { type: 1 });
                this.model.gameOpts.aiPlayers.length = value.maxSlots;
                for (const c of this.model.clients) { c.mapReady = false; c.startPos = -2; }
                for (const ai of this.model.gameOpts.aiPlayers) if (ai) ai.startPos = -2;
                this.resetReady();
            } else if (name === 'slot_open' || name === 'slot_close' || name === 'slot_bot') {
                const slot = args.slotIndex;
                if (!integer(slot, 0, this.model.slots.length - 1) || this.model.slots[slot].type === 3) { this.fail(peer, 'Invalid or occupied slot'); return; }
                if (name === 'slot_bot' && (!integer(args.difficulty, 0, 5) || (args.customBotId !== undefined && !label(args.customBotId, 128)))) { this.fail(peer, 'Invalid bot'); return; }
                this.model.slots[slot] = name === 'slot_bot' ? { type: 4, difficulty: args.difficulty as number, ...(args.customBotId ? { customBotId: args.customBotId as string } : {}) } : { type: name === 'slot_open' ? 1 : 0 };
                this.model.gameOpts.aiPlayers[slot] = name === 'slot_bot' ? { difficulty: args.difficulty as number, ...(args.customBotId ? { customBotId: args.customBotId as string } : {}), countryId: -2, colorId: -2, startPos: -2, teamId: -2 } : undefined;
                this.resetReady();
            } else if (name === 'allow_spectators') {
                if (args.allow !== false) { this.fail(peer, 'Spectators are not supported in this protocol version'); return; }
                this.model.allowSpectators = args.allow;
            } else if (name === 'kick') {
                const target = [...this.peers].find(p => p.client?.id === args.clientId);
                if (!target || target === peer) { this.fail(peer, 'Invalid player'); return; }
                this.reject(target, 'kicked'); return;
            } else if (name === 'make_admin') {
                const target = this.model.clients.find(c => c.id === args.clientId);
                if (!target) { this.fail(peer, 'Invalid player'); return; }
                client.admin = false; target.admin = true;
            } else { this.fail(peer, 'Unknown lobby command'); return; }
        }
        this.syncLobby();
    }
    private startGame(peer: Peer): void {
        const players = this.model.clients.filter(c => c.slotIndex !== null);
        if (!peer.client!.admin || players.length < (this.options.allowSinglePlayer ? 1 : 2) || this.model.clients.some(c => !c.mapReady || (!c.admin && !c.ready))) { this.fail(peer, 'All players must have the map and be ready'); return; }
        this.model.state = 'started';
        this.updatePlayers();
        for (const client of this.model.clients) this.active.add(client.id);
        const timestamp = this.now();
        this.broadcast({ type: 'startGame', gameId: `network-${timestamp}-${Math.floor((this.options.random ?? Math.random)() * 0x100000000).toString(16)}`, timestamp, gameOpts: clone(this.model.gameOpts), humanAssignments: players.map(c => ({ clientId: c.id, slotIndex: c.slotIndex!, name: c.name })), clientIds: [...this.active], orderLatency: this.model.orderLatency, netFrameInterval: this.model.netFrameInterval });
        for (let frame = 1; frame <= this.model.orderLatency; frame++) for (const id of this.active) this.broadcast(encodeOrderPacket(id, frame, new Uint8Array()));
        this.syncLobby();
    }
    private loaded(peer: Peer, percent: unknown): void {
        if (this.model.state !== 'started' || !integer(percent, 0, 100) || percent < peer.client!.loaded) throw new Error('Invalid loading progress');
        peer.client!.loaded = percent;
        this.broadcast({ type: 'loaded', clientId: peer.client!.id, percent });
        this.checkLoaded();
    }
    private checkLoaded(): void {
        if (!this.allLoaded && this.model.state === 'started' && this.model.clients.length && this.model.clients.every(c => c.loaded === 100)) { this.allLoaded = true; this.broadcast({ type: 'allLoaded' }); }
    }
    private receivePacket(peer: Peer, data: Uint8Array): void {
        const packet = decodePacket(data);
        if (packet.kind === 'orders') {
            const minFrame = Math.min(...[...this.peers].filter(p => p.client).map(p => p.lastFrame));
            if (packet.clientId !== peer.client!.id || packet.frame !== peer.lastFrame + 1 || packet.frame > minFrame + 256 || packet.frame > 0xffffffff - this.model.orderLatency) throw new Error('Invalid order sequence');
            peer.lastFrame = packet.frame;
            const frame = packet.frame + this.model.orderLatency;
            this.broadcast(encodeOrderPacket(peer.client!.id, frame, packet.actions));
            this.send(peer, { type: 'ack', frame, count: packet.actions.length });
        } else if (packet.kind === 'sync') {
            if (packet.frame !== peer.lastSync + 1 || packet.frame > peer.lastFrame + this.model.orderLatency || packet.frame > Math.min(...[...this.peers].filter(p => p.client).map(p => p.lastSync)) + 256) throw new Error('Invalid sync sequence');
            peer.lastSync = packet.frame;
            this.broadcast(encodeRelayedSyncPacket(peer.client!.id, packet.frame, packet.hash, packet.defeatMask));
            const reports = this.syncs.get(packet.frame) ?? new Map<number, string>();
            reports.set(peer.client!.id, `${packet.hash}:${packet.defeatMask}`);
            this.syncs.set(packet.frame, reports);
            if (new Set(reports.values()).size > 1) {
                this.model.state = 'ended';
                this.broadcast({ type: 'outOfSync', frame: packet.frame });
                this.syncs.clear();
            } else if ([...this.active].every(id => reports.has(id))) this.syncs.delete(packet.frame);
        } else throw new Error('Clients cannot relay sync packets');
    }
    private chat(peer: Peer, to: unknown, text: unknown): void {
        if (!label(text, 512) || !(to === 'all' || to === 'team' || integer(to, 1, 0xffffffff))) { this.fail(peer, 'Invalid chat message'); return; }
        const sender = peer.client!;
        for (const target of this.peers) if (target.client && (to === 'all' || target === peer || (to === 'team' ? sender.teamId >= 0 && target.client.teamId === sender.teamId : target.client.id === to))) this.send(target, { type: 'chat', clientId: sender.id, to, text: text.trim() });
    }
    private drop(peer: Peer): void {
        if (!this.peers.delete(peer) || !peer.client) return;
        const client = peer.client;
        this.model.clients = this.model.clients.filter(c => c.id !== client.id);
        if (client.id === this.embeddedHostId) { this.stop(); return; }
        if (this.model.state === 'started') {
            // The peer's last stamped order remains authoritative; remove it only on the following frame.
            this.broadcast({ type: 'disconnect', clientId: client.id, frame: peer.lastFrame + this.model.orderLatency + 1 });
            this.active.delete(client.id);
            for (const [frame, reports] of this.syncs) if ([...this.active].every(id => reports.has(id))) this.syncs.delete(frame);
            this.checkLoaded();
        } else if (this.model.state === 'waiting') {
            if (client.slotIndex !== null) this.model.slots[client.slotIndex] = { type: 1 };
            if (client.admin && this.model.clients.length) this.model.clients[0].admin = true;
            this.resetReady();
        }
        this.syncLobby();
    }
}
