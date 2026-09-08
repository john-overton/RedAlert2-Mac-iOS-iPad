import { ResumableConnections } from './ResumableConnections';
import { MatchArchive } from './MatchArchive';
import type { StartGameMessage } from './Protocol';
import { Parser } from '../gameopt/Parser';
import { ActionType } from '../../game/action/ActionType';
import { HEARTBEAT_INTERVAL_MS, CONNECTION_WARNING_MS, CONNECTION_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS } from '../ConnectionHealth';
import { CONTENT_CHUNK_BYTES, decodeContentBytes, encodeContentBytes, validateContentManifest, verifyContentFiles } from '../content/ContentPackage';
import type { ContentManifest } from '../content/ContentPackage';
import type { ContentRequest } from './Protocol';
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
    observerArchiveMaxBytes?: number;
    observerArchiveMaxFrames?: number;
    /** Solo practice and host-versus-AI rooms are allowed by default. */
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
    pendingPings: Set<number>;
    lastPong?: number;
    lastFrame: number;
    lastOrderAt?: number;
    takeover?: 'ai';
    lastSync: number;
    floodAt: number;
    floodCount: number;
    warned: boolean;
    observationId?: number;
    observing?: boolean;
    historyCursor?: number;
    historyAt?: number;
    historyCount?: number;
    contentBusy?: boolean;
    contentGeneration?: number;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const selection = (value: unknown, max: number): value is number => value === -2 || integer(value, 0, max);
const label = (value: unknown, limit = 32): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const scalarOptions: Record<string, [number, number] | 'boolean'> = {
    disconnectAi: 'boolean', gameSpeed: [0, 6], credits: [0, 100000], unitCount: [0, 100], shortGame: 'boolean', superWeapons: 'boolean', buildOffAlly: 'boolean', mcvRepacks: 'boolean', cratesAppear: 'boolean', hostTeams: 'boolean', destroyableBridges: 'boolean', multiEngineer: 'boolean', noDogEngiKills: 'boolean',
};

/** Authoritative, runtime independent lobby and frame relay. Call tick every second. */
export class GameServer {
    private readonly peers = new Set<Peer>();
    private readonly resumableConnections = new ResumableConnections(connection => this.accept(connection));
    private readonly model: Session;
    private readonly now: () => number;
    private readonly syncs = new Map<number, Map<number, string>>();
    private readonly active = new Set<number>();
    private archive?: MatchArchive;
    private matchStart?: StartGameMessage;
    private nextId = 1;
    private allLoaded = false;
    private embeddedHostId?: number;
    private lastHealthBroadcast = -Infinity;
    private stopped = false;
    private contentFiles = new Map<string, Uint8Array>();
    private upload?: { owner: Peer; manifest: ContentManifest; files: Map<string, Uint8Array>; offsets: Map<string, number>; updatedAt: number };


    constructor(private readonly options: GameServerOptions, private readonly transport?: ServerTransport) {
        this.now = options.now ?? Date.now;
        const gameOpts = clone(options.gameOpts);
        if (options.countryCount !== undefined && !integer(options.countryCount, 1, 32)) throw new Error('Invalid country count');
        if (!integer(gameOpts.gameSpeed, 0, 6)) throw new Error('Invalid game speed');
        if (!integer(gameOpts.maxSlots, 1, 8)) throw new Error('Expected 1 to 8 player slots');
        const orderLatency = options.orderLatency ?? 2;
        const netFrameInterval = options.netFrameInterval ?? 1;
        if (!integer(orderLatency, 1, 12) || netFrameInterval !== 1) throw new Error('Invalid network timing');
        this.model = { generation: 0, state: 'waiting', serverName: options.serverName?.trim() || 'Red Alert 2', clients: [], slots: Array.from({ length: gameOpts.maxSlots }, (_, i) => {
            const slot = options.slotsInfo?.[i];
            // The host connects as an ordinary client, so saved human slots begin open.
            return slot?.type === 4 ? clone(slot) : { type: slot?.type === 0 ? 0 : 1 };
        }), gameOpts, orderLatency, netFrameInterval, allowSpectators: options.allowSpectators ?? true };
        gameOpts.humanPlayers = [];
        gameOpts.aiPlayers = Array.from({ length: gameOpts.maxSlots }, (_, i) => this.model.slots[i].type === 4 ? gameOpts.aiPlayers[i] : undefined);
    }
    get isStopped(): boolean { return this.stopped; }
    private get countryMax(): number { return (this.options.countryCount ?? (this.options.identity.engine === 'yr' ? 10 : 9)) - 1; }
    get session(): Session { return { ...clone(this.model), ...(this.model.state === 'started' && !this.archive?.available ? { observationUnavailable: 'Match history exceeded its limit; observation is unavailable for this round.' } : {}) }; }
    start(): void | Promise<void> { return this.transport?.listen(connection => this.resumableConnections.accept(connection)); }
    accept(connection: ServerConnection): void {
        if (this.stopped || this.peers.size >= 24) { connection.close('Server unavailable'); return; }
        const now = this.now();
        const peer: Peer = { connection, connectedAt: now, lastSeen: now, lastPing: now, pendingPings: new Set(), lastFrame: 0, lastSync: 0, floodAt: now, floodCount: 0, warned: false };
        this.peers.add(peer);
        connection.onMessage(data => this.receive(peer, data));
        connection.onClose(() => this.drop(peer));
    }
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.model.state = 'ended';
        this.upload = undefined; this.contentFiles.clear(); this.archive = undefined; this.matchStart = undefined;
        this.broadcast({ type: 'message', key: 'serverClosed' });
        for (const peer of [...this.peers]) { this.peers.delete(peer); peer.connection.close('Server closed'); }
        this.resumableConnections.close();
        this.transport?.close();
    }
    tick(now = this.now()): void {
        if (this.upload && now - this.upload.updatedAt > 60000) this.upload = undefined;
        for (const peer of [...this.peers]) {
            if ((!peer.client && now - peer.connectedAt >= HANDSHAKE_TIMEOUT_MS) || now - peer.lastSeen >= CONNECTION_TIMEOUT_MS) { this.reject(peer, 'timeout'); continue; }
            if (peer.client && now - peer.lastSeen >= CONNECTION_WARNING_MS && !peer.warned) {
                peer.warned = true;
                this.broadcast({ type: 'message', key: 'connectionProblems', args: { clientId: peer.client.id } });
            }
            if (peer.client && now - peer.lastPing >= HEARTBEAT_INTERVAL_MS) {
                for (const sent of peer.pendingPings) if (now - sent >= CONNECTION_TIMEOUT_MS) peer.pendingPings.delete(sent);
                peer.lastPing = now;
                peer.pendingPings.add(now);
                this.send(peer, { type: 'ping', t: now });
            }
        }
        if (this.model.state === 'started' && this.allLoaded && now - this.lastHealthBroadcast >= 1000) {
            this.lastHealthBroadcast = now;
            const peers = this.combatants();
            const maxFrame = Math.max(...peers.map(p => p.lastFrame));
            const maxSync = Math.max(...peers.map(p => p.lastSync));
            const players = peers.map(p => ({ clientId: p.client!.id, ping: p.lastPong === undefined ? null : p.client!.ping,
                lagMs: p.lastFrame < maxFrame || p.lastSync < maxSync ? Math.max(0, now - (p.lastOrderAt ?? now)) : 0 }));
            for (const host of peers.filter(p => p.client!.admin)) this.send(host, { type: 'matchHealth', generation: this.model.generation, players });
        }
        if (this.model.state === 'waiting' && now - this.lastHealthBroadcast >= 1000) {
            this.lastHealthBroadcast = now;
            this.broadcast({ type: 'connectionHealth', timeoutMs: CONNECTION_TIMEOUT_MS,
                players: [...this.peers].filter(peer => peer.client).map(peer => ({
                    clientId: peer.client!.id, ping: peer.lastPong === undefined ? null : peer.client!.ping,
                    idleMs: Math.max(0, now - peer.lastSeen),
                })) });
        }
    }
    private send(peer: Peer, message: ServerMessage | Uint8Array): void {
        try { peer.connection.send(message instanceof Uint8Array ? message : JSON.stringify(message)); }
        catch { this.drop(peer); }
    }
    private broadcast(message: ServerMessage | Uint8Array): void { for (const peer of [...this.peers]) if (peer.client) this.send(peer, message); }
    private broadcastCombatants(message: ServerMessage | Uint8Array): void { for (const peer of this.combatants()) this.send(peer, message); }
    private syncLobby(): void { this.updatePlayers(); this.broadcast({ type: 'session', session: this.session }); }
    private updatePlayers(): void {
        this.model.gameOpts.humanPlayers = this.model.clients.filter(c => c.slotIndex !== null).sort((a, b) => a.slotIndex! - b.slotIndex!).map(c => ({ name: c.name, countryId: c.countryId, colorId: c.colorId, startPos: c.startPos, teamId: c.teamId }));
    }
    private reject(peer: Peer, code: string, message?: string): void { this.send(peer, { type: 'error', code, ...(message ? {message} : {}) }); this.drop(peer); peer.connection.close(code); }
    private fail(peer: Peer, message: string): void { this.send(peer, { type: 'error', code: 'invalidCommand', message }); }
    private receive(peer: Peer, data: WireData): void {
        if (!this.peers.has(peer)) return;
        if (data.length > MAX_PACKET_BYTES || (typeof data === 'string' && new TextEncoder().encode(data).length > MAX_PACKET_BYTES)) { this.reject(peer, 'packetTooLarge'); return; }
        try {
            if (typeof data !== 'string') {
                // Buffered frames may arrive after the first mismatch. Preserve that
                // diagnosis instead of turning normal in-flight traffic into a drop.
                if (peer.client && (this.model.state !== 'started' || !this.active.has(peer.client.id))) return;
                if (decodePacket(data).generation !== this.model.generation) return;
                if (!peer.client || this.model.state !== 'started' || !this.allLoaded) throw new Error('Unexpected orders');
                this.receivePacket(peer, data);
            } else {
                let message: any;
                try { message = JSON.parse(data); } catch { throw new Error('Malformed JSON message'); }
                if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
                if (!peer.client) { if (message.type !== 'hello') throw new Error('Handshake required'); this.hello(peer, message); }
                else if (message.type === 'pong') {
                    if (typeof message.t !== 'number' || !Number.isFinite(message.t) || message.t > peer.lastPing || message.t < peer.connectedAt) throw new Error('Invalid heartbeat reply');
                    // A stalled link can deliver replies after newer probes have
                    // been sent. Match outstanding probes, not only the last one.
                    // Ignore duplicates/expired replies without refreshing liveness.
                    if (!peer.pendingPings.delete(message.t)) return;
                    if (peer.lastPong === undefined || message.t > peer.lastPong) {
                        peer.lastPong = message.t;
                        peer.client.ping = Math.max(0, this.now() - message.t);
                    }
                }
                else if (message.type === 'ping') { if (typeof message.t !== 'number' || !Number.isFinite(message.t)) throw new Error('Invalid ping'); this.send(peer, { type: 'pong', t: message.t }); }
                else if (message.type === 'content') {
                    if (message.action === 'cancel' && peer.client.admin && integer(message.requestId,1,0xffffffff)) {
                        peer.contentGeneration=(peer.contentGeneration??0)+1;
                        if(this.upload?.owner===peer) this.upload=undefined;
                        this.send(peer,{type:'contentResult',requestId:message.requestId});
                        peer.lastSeen=this.now();peer.warned=false;
                        return;
                    }
                    if (peer.contentBusy) {
                        if (!integer(message.requestId, 1, 0xffffffff)) throw new Error('Invalid content request ID');
                        this.send(peer, {type:'contentResult', requestId:message.requestId, error:'A content request is still in progress. Please retry.'});
                        return;
                    }
                    peer.contentBusy = true;
                    void this.contentRequest(peer, message).finally(() => { peer.contentBusy = false; });
                }
                else if (message.type === 'history') this.history(peer, message);
                else if (message.type === 'loaded') { if (this.isCurrentMatch(message)) this.loaded(peer, message.percent); }
                else if (message.type === 'returnToLobby') { if (this.isCurrentMatch(message)) this.returnToLobby(peer, message.reason, message.observationId); }
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
        } catch (error) { this.reject(peer, 'invalidPacket', error instanceof Error ? error.message : 'Malformed packet'); }
    }
    private hello(peer: Peer, hello: HelloMessage): void {
        const expected = this.options.identity;
        let error: string | undefined;
        if (this.model.state === 'ended') error = 'gameStarted';
        else if (this.options.password && !hello.password) error = 'passwordRequired';
        else if (this.options.password && hello.password !== this.options.password) error = 'passwordWrong';
        else if (hello.mod !== expected.mod || hello.modHash !== expected.modHash || hello.engine !== expected.engine) error = 'modMismatch';
        else if (hello.version !== expected.version) error = 'versionMismatch';
        else if (hello.assetFingerprint !== expected.assetFingerprint) error = 'assetMismatch';
        else if (hello.protocol !== HANDSHAKE_PROTOCOL || hello.ordersProtocol !== ORDERS_PROTOCOL) error = 'protocolMismatch';
        else if (!label(hello.name) || this.model.clients.some(c => c.name.toLowerCase() === hello.name.trim().toLowerCase())) error = 'invalidName';
        if (!error && hello.role !== undefined && hello.role !== 'player' && hello.role !== 'observer') error = 'invalidRole';
        if (!error && hello.role === 'observer' && !this.model.allowSpectators) error = 'spectatorsDisabled';
        const slot = this.model.state === 'waiting' && hello.role !== 'observer' ? this.model.slots.findIndex(s => s.type === 1) : -1;
        if (!error && slot < 0 && this.model.state === 'waiting' && hello.role !== 'observer') error = 'full';
        if (error) { this.reject(peer, error); return; }
        peer.client = { id: this.nextId++, role: hello.role === 'observer' ? 'observer' : slot >= 0 ? 'player' : 'waiting', name: hello.name.trim(), slotIndex: slot < 0 ? null : slot, countryId: selection(hello.preferredCountry, this.countryMax) ? hello.preferredCountry : -2, colorId: selection(hello.preferredColor, 7) ? hello.preferredColor : -2, startPos: -2, teamId: -2, admin: this.model.clients.length === 0, ready: false, mapReady: false, loaded: 0, ping: 0 };
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
        if (!args || typeof args !== 'object' || Array.isArray(args)) { this.fail(peer, 'Invalid arguments'); return; }
        if (name === 'sync_lobby') { this.send(peer, { type: 'session', session: this.session }); return; }
        if (name === 'role') {
            if (this.model.state === 'waiting') client.ready = false;
            if (args.role !== 'player' && args.role !== 'observer') { this.fail(peer, 'Invalid role'); return; }
            if (this.model.state === 'started' && client.role === 'waiting' && args.role === 'observer' && this.model.allowSpectators) { client.role = 'observer'; this.syncLobby(); return; }
            name = args.role === 'observer' ? 'spectate' : 'player';
        }
        if (name === 'observe') {
            if (!this.isCurrentMatch(args)) return;
            if (client.role === 'waiting' && this.model.allowSpectators) { client.role = 'observer'; this.syncLobby(); }
            this.observe(peer); return;
        }
        if (name === 'map_ready' || name === 'content_ready') {
            if (name === 'map_ready') client.mapReady = args.digest === this.model.gameOpts.mapDigest;
            else client.contentReady = args.id === this.model.content?.id ? args.id as string : undefined;
            client.ready = false; this.syncLobby(); return;
        }
        if (name === 'kick_ai' && this.model.state === 'started') {
            if (args.generation !== this.model.generation || args.gameId !== this.model.gameId) return;
            const target = [...this.peers].find(p => p.client?.id === args.clientId);
            if (!client.admin || !this.active.has(client.id) || !this.allLoaded || !target || target === peer || !this.active.has(target.client!.id)) {
                this.fail(peer, 'Only the host can replace another active player with AI.'); return;
            }
            target.takeover = 'ai';
            this.reject(target, 'kicked', 'The host replaced your connection with AI.');
            return;
        }
        if (this.model.state !== 'waiting') { this.fail(peer, 'The game has already started'); return; }
        if (client.ready && name !== 'state' && name !== 'ready' && name !== 'startgame') { this.fail(peer, 'Unready before changing the lobby'); return; }
        if (name === 'state' || name === 'ready') {
            if (args.mapDigest === this.model.gameOpts.mapDigest) client.mapReady = true;
            if (typeof args.ready !== 'boolean' || (args.ready && (!client.mapReady || Boolean(this.model.content && client.contentReady !== this.model.content.id)))) { this.fail(peer, 'The selected map must be available before readying'); return; }
            client.ready = args.ready;
        } else if (name === 'content_ready') {
            client.contentReady = args.id === this.model.content?.id ? args.id as string : undefined;
            if (!client.contentReady) client.ready = false;
        } else if (name === 'map_ready') {
            client.mapReady = args.digest === this.model.gameOpts.mapDigest;
            if (!client.mapReady) client.ready = false;
        } else if (name === 'startgame') { this.startGame(peer); return; }
        else if (name === 'name') {
            if (!label(args.name) || this.model.clients.some(c => c !== client && c.name.toLowerCase() === (args.name as string).trim().toLowerCase())) { this.fail(peer, 'Choose a unique player name'); return; }
            client.name = args.name.trim();
            if (client.slotIndex !== null) this.model.slots[client.slotIndex].name = client.name;
        } else if (name === 'player') {
            const slot = args.slotIndex ?? client.slotIndex ?? this.model.slots.findIndex(s => s.type === 1);
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
                client.role = 'player'; client.slotIndex = slot; this.model.slots[slot] = { type: 3, name: client.name };
            }
            for (const key of ['countryId', 'colorId', 'startPos', 'teamId'] as const) if (args[key] !== undefined) target[key] = args[key] as number;
            if (target !== client) this.resetReady();
        } else if (name === 'spectate') {
            if (!this.model.allowSpectators) { this.fail(peer, 'Spectators are disabled'); return; }
            if (client.slotIndex !== null) this.model.slots[client.slotIndex] = { type: 1 };
            client.slotIndex = null; client.role = 'observer'; client.ready = false;
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
                if (typeof args.allow !== 'boolean') { this.fail(peer, 'Invalid spectator setting'); return; }
                if (!args.allow && this.model.clients.some(c => c.role === 'observer')) { this.fail(peer, 'Observers must leave their role first'); return; }
                this.model.allowSpectators = args.allow;
            } else if (name === 'kick') {
                const target = [...this.peers].find(p => p.client?.id === args.clientId);
                if (!target || target === peer) { this.fail(peer, 'Invalid player'); return; }
                this.reject(target, 'kicked'); return;
            } else if (name === 'make_admin') {
                const target = this.model.clients.find(c => c.id === args.clientId);
                if (!target) { this.fail(peer, 'Invalid player'); return; }
                if(this.upload?.owner===peer) this.upload=undefined;
                peer.contentGeneration=(peer.contentGeneration??0)+1;
                client.admin = false; target.admin = true;
            } else { this.fail(peer, 'Unknown lobby command'); return; }
        }
        this.syncLobby();
    }
    private async contentRequest(peer: Peer, request: ContentRequest): Promise<void> {
        const reply = (result: {error?: string; data?: string} = {}) => this.send(peer, {type:'contentResult', requestId:request.requestId, ...result});
        try {
            if (!integer(request.requestId, 1, 0xffffffff) || (this.model.state !== 'waiting' && request.action !== 'get')) throw new Error('Content transfer unavailable');
            if (request.action === 'get') {
                if (request.id !== this.model.content?.id) throw new Error('Content package changed');
                const bytes = this.contentFiles.get(request.path!);
                if (!bytes || !integer(request.offset,0,bytes.length-1) || request.offset % CONTENT_CHUNK_BYTES !== 0) throw new Error('Invalid content download');
                reply({data:encodeContentBytes(bytes.subarray(request.offset,request.offset+CONTENT_CHUNK_BYTES))}); return;
            }
            if (!peer.client?.admin) throw new Error('Only the host can publish content');
            if (request.action === 'cancel') { if (this.upload?.owner === peer) this.upload = undefined; reply(); return; }
            if (request.action === 'begin') {
                if (this.upload) throw new Error('Content upload already in progress');
                const generation=peer.contentGeneration??0;
                const manifest = await validateContentManifest(request.manifest);
                if (!this.peers.has(peer) || !peer.client.admin || this.model.state !== 'waiting' || generation!==(peer.contentGeneration??0)) throw new Error('Content upload cancelled');
                this.upload = {owner:peer,manifest,files:new Map(),offsets:new Map(),updatedAt:this.now()};
                this.resetReady(); this.syncLobby();
            } else {
                const upload = this.upload;
                if (!upload || upload.owner !== peer || request.id !== upload.manifest.id) throw new Error('Content upload expired');
                upload.updatedAt = this.now();
                if (request.action === 'put') {
                    const entry = upload.manifest.files.find(file => file.path === request.path);
                    if (!entry || request.offset !== (upload.offsets.get(entry.path) ?? 0)) throw new Error('Invalid content upload offset');
                    const chunk = decodeContentBytes(request.data!);
                    if (request.offset! + chunk.length > entry.size) throw new Error('Content upload exceeds declared size');
                    let bytes = upload.files.get(entry.path);
                    if (!bytes) { bytes = new Uint8Array(entry.size); upload.files.set(entry.path,bytes); }
                    bytes.set(chunk,request.offset); upload.offsets.set(entry.path,request.offset!+chunk.length);
                } else if (request.action === 'commit') {
                    if (upload.manifest.files.some(file => upload.offsets.get(file.path) !== file.size)) throw new Error('Content upload incomplete');
                    await verifyContentFiles(upload.manifest,Array.from(upload.files,([path,bytes]) => ({path,bytes})));
                    if (this.upload !== upload || !this.peers.has(peer) || !peer.client.admin || this.model.state !== 'waiting') throw new Error('Content upload cancelled');
                    this.contentFiles = upload.files; this.model.content = upload.manifest; this.upload = undefined;
                    for (const client of this.model.clients) { client.ready=false; client.mapReady=false; client.contentReady=undefined; }
                    this.syncLobby();
                } else throw new Error('Unknown content operation');
            }
            reply();
        } catch (error) { reply({error:error instanceof Error ? error.message : 'Content transfer failed'}); }
    }
    private startGame(peer: Peer): void {
        const players = this.model.clients.filter(c => c.slotIndex !== null);
        if (this.upload || [...this.peers].some(p=>p.contentBusy && p.client?.role === 'player') || !peer.client!.admin || players.length < (this.options.allowSinglePlayer === false ? 2 : 1) || players.some(c => !c.mapReady || (this.model.content && c.contentReady !== this.model.content.id) || (!c.admin && !c.ready))) { this.fail(peer, 'All players must have the map and be ready'); return; }
        this.model.state = 'started';
        this.model.generation++;
        this.allLoaded = false; this.syncs.clear(); this.active.clear();
        this.archive = new MatchArchive(this.options.observerArchiveMaxBytes, this.options.observerArchiveMaxFrames);
        for (const member of this.peers) { member.lastOrderAt = this.now(); member.lastFrame = 0; member.lastSync = 0; member.takeover = undefined; member.observing = false; if (member.client) member.client.loaded = 0; }
        this.updatePlayers();
        for (const client of players) this.active.add(client.id);
        const timestamp = this.now();
        this.model.gameId = `network-${timestamp}-${this.model.generation}-${Math.floor((this.options.random ?? Math.random)() * 0x100000000).toString(16)}`;
        this.matchStart = { type: 'startGame', gameId: this.model.gameId, generation: this.model.generation, timestamp, gameOpts: clone(this.model.gameOpts), humanAssignments: players.map(c => ({ clientId: c.id, slotIndex: c.slotIndex!, name: c.name })), clientIds: [...this.active], orderLatency: this.model.orderLatency, netFrameInterval: this.model.netFrameInterval };
        this.broadcastCombatants(this.matchStart);
        for (const member of this.peers) if (member.client?.role === 'observer' && this.observerReady(member)) this.observe(member);
        for (let frame = 1; frame <= this.model.orderLatency; frame++) for (const id of this.active) { this.archive.order(frame, id, new Uint8Array()); this.broadcastCombatants(encodeOrderPacket(id, frame, new Uint8Array(), this.model.generation)); }
        this.syncLobby();
    }
    private loaded(peer: Peer, percent: unknown): void {
        if (!this.active.has(peer.client!.id)) return;
        if (this.model.state !== 'started' || !integer(percent, 0, 100) || percent < peer.client!.loaded) throw new Error('Invalid loading progress');
        peer.client!.loaded = percent;
        this.broadcast({ type: 'loaded', generation: this.model.generation, clientId: peer.client!.id, percent });
        this.checkLoaded();
    }
    private checkLoaded(): void {
        if (!this.allLoaded && this.model.state === 'started' && this.active.size && this.combatants().every(p => p.client!.loaded === 100)) { this.allLoaded = true; this.broadcast({ type: 'allLoaded', generation: this.model.generation }); }
    }
    private receivePacket(peer: Peer, data: Uint8Array): void {
        const packet = decodePacket(data);
        if (packet.kind === 'orders') {
            // The relay otherwise treats action payloads as opaque; reserve these
            // replay actions for server-scheduled disconnects, never player input.
            let actions: { id: number }[] = [];
            try { if (packet.actions.length) actions = new Parser().parsePlayerActions(packet.actions); } catch { /* Clients validate malformed game actions. */ }
            if (actions.some(action => action.id === ActionType.AiTakeover || action.id === ActionType.DestroyDisconnectedPlayer)) throw new Error('Server-only action');
            const minFrame = Math.min(...this.combatants().map(p => p.lastFrame));
            if (packet.clientId !== peer.client!.id || packet.frame !== peer.lastFrame + 1 || packet.frame > minFrame + 256 || packet.frame > 0xffffffff - this.model.orderLatency) throw new Error('Invalid order sequence');
            peer.lastFrame = packet.frame;
            peer.lastOrderAt = this.now();
            const frame = packet.frame + this.model.orderLatency;
            this.archive?.order(frame, peer.client!.id, packet.actions);
            this.broadcastCombatants(encodeOrderPacket(peer.client!.id, frame, packet.actions, this.model.generation));
            this.send(peer, { type: 'ack', generation: this.model.generation, frame, count: packet.actions.length });
        } else if (packet.kind === 'sync') {
            if (packet.frame !== peer.lastSync + 1 || packet.frame > peer.lastFrame + this.model.orderLatency || packet.frame > Math.min(...this.combatants().map(p => p.lastSync)) + 256) throw new Error('Invalid sync sequence');
            peer.lastSync = packet.frame;
            this.broadcastCombatants(encodeRelayedSyncPacket(peer.client!.id, packet.frame, packet.hash, packet.defeatMask, this.model.generation));
            const reports = this.syncs.get(packet.frame) ?? new Map<number, string>();
            reports.set(peer.client!.id, `${packet.hash}:${packet.defeatMask}`);
            this.syncs.set(packet.frame, reports);
            if (new Set(reports.values()).size > 1) {
                this.broadcast({ type: 'outOfSync', generation: this.model.generation, frame: packet.frame });
                this.finishMatch('desync');
            } else if ([...this.active].every(id => reports.has(id))) { this.archive?.agree(packet.frame, packet.hash, packet.defeatMask.toString()); this.syncs.delete(packet.frame); }
        } else throw new Error('Clients cannot relay sync packets');
    }
    private combatants(): Peer[] { return [...this.peers].filter(p => p.client && this.active.has(p.client.id)); }
    private isCurrentMatch(message: { gameId?: unknown; generation?: unknown }): boolean {
        return this.model.state === 'started' && message.gameId === this.model.gameId && message.generation === this.model.generation;
    }
    private returnToLobby(peer: Peer, reason: unknown, observationId?: number): void {
        if (peer.client!.role === 'observer') { if (observationId === peer.observationId) { peer.observing = false; peer.historyCursor = undefined; } return; }
        if (reason !== 'finished' && reason !== 'forfeit') { this.fail(peer, 'Invalid match return reason'); return; }
        if (!this.active.has(peer.client!.id)) return;
        // A completion claim only releases this commander. Other commanders must
        // independently return before the room can start another match.
        this.removeCombatant(peer, reason === 'finished' ? 'finished' : 'abandoned');
        this.syncLobby();
    }
    private removeCombatant(peer: Peer, lastReason: 'finished' | 'abandoned' = 'abandoned'): void {
        if (!this.active.delete(peer.client!.id)) return;
        // Retain every already-stamped order, then remove the commander on the next frame.
        const drop = { clientId: peer.client!.id, frame: peer.lastFrame + this.model.orderLatency + 1, ...(peer.takeover || this.model.gameOpts.disconnectAi ? { takeover: 'ai' as const } : {}) };
        this.archive?.drop(drop);
        this.broadcastCombatants({ type: 'disconnect', generation: this.model.generation, ...drop });
        for (const [frame, reports] of this.syncs) if (this.active.size && [...this.active].every(id => reports.has(id))) { const [hash, mask] = reports.get([...this.active][0])!.split(':'); this.archive?.agree(frame, Number(hash), mask); this.syncs.delete(frame); }
        if (!this.active.size) this.finishMatch(lastReason);
        else this.checkLoaded();
    }
    private finishMatch(reason: 'finished' | 'abandoned' | 'desync'): void {
        this.broadcast({ type: 'matchEnded', gameId: this.model.gameId!, generation: this.model.generation, reason });
        this.model.state = 'waiting';
        this.model.gameId = undefined;
        this.active.clear(); this.syncs.clear(); this.allLoaded = false; this.archive = undefined; this.matchStart = undefined;
        this.lastHealthBroadcast = -Infinity;
        for (const peer of this.peers) {
            peer.lastFrame = 0; peer.lastSync = 0; peer.lastOrderAt = undefined; peer.takeover = undefined;
            if (peer.client) { peer.client.ready = false; peer.client.loaded = 0; }
        }
        this.syncLobby();
    }
    private observerReady(peer: Peer): boolean { return Boolean(peer.client?.mapReady && (!this.model.content || peer.client.contentReady === this.model.content.id)); }
    private observe(peer: Peer): void {
        // A repeated click must not invalidate an already-loading subscription.
        if (peer.observing) return;
        if (this.model.state !== 'started' || peer.client!.role !== 'observer' || !this.model.allowSpectators || !this.observerReady(peer) || !this.archive?.available || !this.matchStart) { this.send(peer, { type: 'error', code: 'observerUnavailable', message: 'Observation requires a running match, its content, and available history.' }); return; }
        peer.observing = true; peer.observationId = (peer.observationId ?? 0) + 1; peer.historyCursor = 1; peer.historyAt = undefined;
        this.send(peer, { ...clone(this.matchStart), observer: true, observationId: peer.observationId, liveFrame: this.archive.liveFrame });
    }
    private history(peer: Peer, message: any): void {
        if (!this.isCurrentMatch(message) || message.observationId !== peer.observationId) return;
        const now = this.now();
        if (peer.historyAt === undefined || now - peer.historyAt >= 1000) { peer.historyAt = now; peer.historyCount = 0; }
        if ((peer.historyCount = (peer.historyCount ?? 0) + 1) > 128) { peer.observing = false; this.send(peer, { type: 'error', code: 'observerUnavailable', message: 'History request rate exceeded; retry observation.' }); return; }
        if (peer.client!.role !== 'observer' || !peer.observing || !this.archive?.available) { this.send(peer, { type: 'error', code: 'observerUnavailable' }); return; }
        if (!integer(message.fromFrame, 1, 0xffffffff) || message.fromFrame !== peer.historyCursor || (message.maxFrames !== undefined && !integer(message.maxFrames,1,32))) { this.fail(peer, 'Invalid history cursor'); return; }
        // Pull is acknowledgement of the previous chunk: only one sequential chunk is in flight.
        const frames = this.archive.read(message.fromFrame, message.maxFrames);
        if (!this.archive.available) { this.send(peer, { type: 'error', code: 'observerUnavailable' }); return; }
        peer.historyCursor += frames.length;
        this.send(peer, { type: 'history', gameId: this.model.gameId!, generation: this.model.generation, observationId: peer.observationId!, fromFrame: message.fromFrame, frames, liveFrame: this.archive.liveFrame, allLoaded: this.allLoaded });
    }
    private chat(peer: Peer, to: unknown, text: unknown): void {
        if (!label(text, 512) || !(to === 'all' || to === 'team' || to === 'observers' || integer(to, 1, 0xffffffff))) { this.fail(peer, 'Invalid chat message'); return; }
        const sender = peer.client!;
        const recipient = typeof to === 'number' ? this.model.clients.find(c => c.id === to) : undefined;
        if ((sender.role === 'observer' && to !== 'observers' && !(recipient?.role === 'observer')) || (to === 'observers' && sender.role !== 'observer') || ((sender.role === 'waiting' || (this.model.state === 'started' && sender.role === 'player' && !this.active.has(sender.id))) && (to === 'team' || recipient && recipient.role !== 'waiting')) || (recipient?.role === 'observer' && sender.role !== 'observer') || (typeof to === 'number' && !recipient)) { this.fail(peer, 'That chat channel is unavailable for your role'); return; }
        const identity = (c: SessionClient) => ({ name: c.name, colorId: c.colorId, teamId: c.teamId });
        for (const target of this.peers) if (target.client && (target === peer || (to === 'all' ? true : to === 'observers' ? target.client.role === 'observer' : to === 'team' ? target.client.role === 'observer' || (target.client.role === 'player' && (this.model.state !== 'started' || this.active.has(target.client.id)) && sender.teamId >= 0 && target.client.teamId === sender.teamId) : target.client.id === to))) this.send(target, { type: 'chat', clientId: sender.id, to, text: text.trim(), sender: identity(sender), ...(recipient ? { recipient: identity(recipient) } : {}) });
    }
    private drop(peer: Peer): void {
        if (!this.peers.delete(peer) || !peer.client) return;
        const client = peer.client;
        if (this.upload?.owner === peer) this.upload = undefined;
        this.model.clients = this.model.clients.filter(c => c.id !== client.id);
        if (client.id === this.embeddedHostId) { this.stop(); return; }
        if (client.slotIndex !== null) this.model.slots[client.slotIndex] = { type: 1 };
        if (client.admin && this.model.clients.length) this.model.clients[0].admin = true;
        if (this.model.state === 'started') this.removeCombatant(peer);
        else this.resetReady();
        this.syncLobby();
    }
}
