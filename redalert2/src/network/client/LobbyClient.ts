import { HANDSHAKE_TIMEOUT_MS, type ConnectionHealth } from '../ConnectionHealth';
import { CONTENT_CHUNK_BYTES, MAX_CONTENT_BYTES, sha256, contentPath, createContentManifest, decodeContentBytes, encodeContentBytes, validateContentManifest, verifyContentFiles } from '../content/ContentPackage';
import type { ContentFile, ContentManifest } from '../content/ContentPackage';
import type { ContentRequest, ContentResponse } from '../server/Protocol';
import { EventDispatcher } from '@/util/event';
import type { HelloMessage, ServerMessage, StartGameMessage } from '@/network/server/Protocol';
import type { Session } from '@/network/server/Session';
import { WebSocketConnection } from './WebSocketConnection';
import { NetworkMatchSession } from './NetworkMatchSession';

export class LobbyConnectionError extends Error {
    constructor(readonly code: string, message: string, readonly disconnected = false) { super(message); this.name = 'LobbyConnectionError'; }
}

const ERRORS: Record<string, string> = {
    passwordRequired: 'This game requires a password.', passwordWrong: 'The password is incorrect.',
    gameStarted: 'This game has already started.', versionMismatch: 'The server is running a different game version.',
    modMismatch: 'The server uses different rules or a different mod.',
    assetMismatch: 'Your retail asset import differs from the server. Each player must import matching assets; retail files are never transferred.',
    protocolMismatch: 'The server uses an incompatible multiplayer protocol.', full: 'The game is full.',
    timeout: 'The server stopped receiving replies. Rejoin when your connection is stable.',
    invalidPacket: 'The server rejected a network message.',
    packetTooLarge: 'A network message exceeded the server limit.',
    banned: 'You are banned from this server.', kicked: 'You were removed from the game.',
};

export class LobbyClient {
    readonly onConnectionHealth = new EventDispatcher<this, ConnectionHealth & { serverIdleMs: number }>();
    readonly onSession = new EventDispatcher<this, Session>();
    readonly onChat = new EventDispatcher<this, Extract<ServerMessage, { type: 'chat' }>>();
    readonly onStartGame = new EventDispatcher<this, StartGameMessage>();
    readonly onError = new EventDispatcher<this, LobbyConnectionError>();
    readonly onMessage = new EventDispatcher<this, Extract<ServerMessage, { type: 'message' }>>();
    session?: Session;
    clientId?: number;
    private match?: NetworkMatchSession;
    private handshakeResolve?: () => void;
    private handshakeReject?: (error: Error) => void;
    private intentionalClose = false;
    private disconnectError?: LobbyConnectionError;
    private health?: ConnectionHealth;
    private lastReceivedAt = 0;
    private healthTimer?: ReturnType<typeof setInterval>;
    getConnectionHealth(): (ConnectionHealth & {serverIdleMs:number}) | undefined {
        return this.health && {...this.health, serverIdleMs:Math.max(0, Date.now() - this.lastReceivedAt)};
    }
    private emitConnectionHealth(): void {
        const health = this.getConnectionHealth();
        if (health) this.onConnectionHealth.dispatch(this, health);
    }
    private nextContentRequest = 1;
    private readonly contentRequests = new Map<number, {resolve:(response:ContentResponse)=>void; reject:(error:Error)=>void}>();
    private publishingContent = false;
    private static readonly cachedFiles = new Map<string,Uint8Array>();
    private static cachedBytes = 0;


    constructor(readonly connection = new WebSocketConnection()) {
        connection.onMessage.subscribe(this.receive);
        connection.onClose.subscribe(this.closed);
    }
    async connect(address: string, hello: HelloMessage): Promise<void> {
        this.intentionalClose = false; this.disconnectError = undefined; this.health = undefined;
        await this.connection.connect(address);
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new LobbyConnectionError('timeout', 'The server did not complete the handshake.');
                this.handshakeReject?.(error); this.close();
            }, HANDSHAKE_TIMEOUT_MS);
            this.handshakeResolve = () => { clearTimeout(timer); this.handshakeResolve = undefined; this.handshakeReject = undefined; resolve(); };
            this.handshakeReject = error => { clearTimeout(timer); this.handshakeResolve = undefined; this.handshakeReject = undefined; reject(error); };
            try { this.connection.sendImmediate({ ...hello, type: 'hello' }); }
            catch (error) { this.handshakeReject?.(error as Error); }
        });
    }
    command(name: string, args?: Record<string, unknown>): void { this.connection.sendImmediate({ type: 'command', name, args }); }
    chat(text: string, to: 'all' | 'team' | number = 'all'): void { this.connection.sendImmediate({ type: 'chat', to, text }); }
    contentReady(id: string): void { this.command('content_ready', {id}); }
    private requestContent(message: Omit<ContentRequest,'type'|'requestId'>, signal?: AbortSignal): Promise<ContentResponse> {
        if (signal?.aborted) return Promise.reject(new Error('Content transfer cancelled'));
        return new Promise((resolve,reject) => {
            const requestId = this.nextContentRequest++;
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); this.contentRequests.delete(requestId); };
            const abort = () => { cleanup(); reject(new Error('Content transfer cancelled')); };
            const timer = setTimeout(() => { cleanup(); reject(new Error('Content transfer timed out')); },60000);
            this.contentRequests.set(requestId,{resolve:response => {cleanup(); response.error ? reject(new Error(response.error)) : resolve(response);},reject:error=>{cleanup();reject(error);}});
            signal?.addEventListener('abort',abort,{once:true});
            try { this.connection.sendImmediate({type:'content',requestId,...message}); }
            catch(error) { cleanup(); reject(error); }
        });
    }
    async publishContent(files: ContentFile[], onProgress?: (received:number,total:number)=>void, signal?: AbortSignal): Promise<ContentManifest> {
        if (this.publishingContent) throw new Error('Content upload already in progress');
        this.publishingContent = true;
        let begun = false;
        try {
            const normalized = files.map(file=>({path:contentPath(file.path),bytes:file.bytes.slice()}));
            const manifest = await createContentManifest(normalized);
            begun=true; await this.requestContent({action:'begin',manifest},signal);
            let transferred=0; onProgress?.(0,manifest.totalBytes);
            for (const file of normalized) for (let offset=0;offset<file.bytes.length;offset+=CONTENT_CHUNK_BYTES) {
                const bytes=file.bytes.subarray(offset,offset+CONTENT_CHUNK_BYTES);
                await this.requestContent({action:'put',id:manifest.id,path:file.path,offset,data:encodeContentBytes(bytes)},signal);
                transferred+=bytes.length; onProgress?.(transferred,manifest.totalBytes);
            }
            await this.requestContent({action:'commit',id:manifest.id},signal);
            return manifest;
        } catch(error) { if (begun) await this.requestContent({action:'cancel'}).catch(()=>{}); throw error; }
        finally { this.publishingContent=false; }
    }
    async downloadContent(manifest: ContentManifest, onProgress?: (received:number,total:number)=>void, signal?: AbortSignal): Promise<ContentFile[]> {
        manifest=await validateContentManifest(manifest);
        if (signal?.aborted || this.session?.content?.id !== manifest.id) throw new Error('Content package changed or transfer cancelled');
        const files:ContentFile[]=[]; let received=0; onProgress?.(0,manifest.totalBytes);
        for (const entry of manifest.files) {
            const cached=LobbyClient.cachedFiles.get(entry.sha256);
            if (cached && cached.length===entry.size && await sha256(cached)===entry.sha256) {
                files.push({path:entry.path,bytes:cached.slice()});received+=cached.length;onProgress?.(received,manifest.totalBytes);
                LobbyClient.cachedFiles.delete(entry.sha256);LobbyClient.cachedFiles.set(entry.sha256,cached);continue;
            }
            const bytes=new Uint8Array(entry.size);
            for(let offset=0;offset<entry.size;offset+=CONTENT_CHUNK_BYTES) {
                if (this.session?.content?.id !== manifest.id) throw new Error('Content package changed');
                const response=await this.requestContent({action:'get',id:manifest.id,path:entry.path,offset},signal);
                const chunk=decodeContentBytes(response.data!);
                if(chunk.length!==Math.min(CONTENT_CHUNK_BYTES,entry.size-offset)) throw new Error('Content chunk size mismatch');
                bytes.set(chunk,offset); received+=chunk.length; onProgress?.(received,manifest.totalBytes);
            }
            files.push({path:entry.path,bytes});
        }
        await verifyContentFiles(manifest,files);
        if(signal?.aborted || this.session?.content?.id!==manifest.id) throw new Error('Content package changed or transfer cancelled');
        for (const entry of manifest.files) {
            if (LobbyClient.cachedFiles.has(entry.sha256)) continue;
            const bytes=files.find(file=>file.path===entry.path)!.bytes;
            while (LobbyClient.cachedBytes+bytes.length>MAX_CONTENT_BYTES && LobbyClient.cachedFiles.size) {
                const [key,value]=LobbyClient.cachedFiles.entries().next().value!;LobbyClient.cachedBytes-=value.length;LobbyClient.cachedFiles.delete(key);
            }
            LobbyClient.cachedFiles.set(entry.sha256,bytes.slice());LobbyClient.cachedBytes+=bytes.length;
        }
        return files;
    }
    private cancelContentRequests(error:Error):void { for(const request of this.contentRequests.values()) request.reject(error); }
    getMatchSession(): NetworkMatchSession {
        if (!this.match) throw new Error('The game has not started.');
        return this.match;
    }
    close(): void {
        this.intentionalClose = true;
        clearInterval(this.healthTimer); this.healthTimer = undefined; this.health = undefined;
        this.cancelContentRequests(new Error('Connection cancelled.'));
        this.handshakeReject?.(new Error('Connection cancelled.'));
        this.match?.dispose(); this.match = undefined;
        this.connection.close(); this.session = undefined; this.clientId = undefined;
    }
    private readonly closed = (reason: string) => {
        clearInterval(this.healthTimer); this.healthTimer = undefined;
        const error = new LobbyConnectionError(this.disconnectError?.code ?? 'disconnected',
            this.disconnectError?.message ?? ERRORS[reason] ?? reason, true);
        this.cancelContentRequests(error);
        this.handshakeReject?.(error);
        if (!this.intentionalClose) {
            // Lobby listeners can dispose the match while this close event is dispatching.
            this.match?.fail(error.message);
            this.onError.dispatch(this, error);
        }
    };
    private readonly receive = (data: string | Uint8Array) => {
        this.lastReceivedAt = Date.now();
        if (typeof data !== 'string') return;
        try {
            const message: ServerMessage = JSON.parse(data);
            switch (message.type) {
                case 'contentResult': this.contentRequests.get(message.requestId)?.resolve(message); break;
                case 'welcome':
                    this.clientId = message.clientId; this.session = message.session;
                    clearInterval(this.healthTimer);
                    this.healthTimer = setInterval(() => this.emitConnectionHealth(), 1000);
                    this.handshakeResolve?.(); this.onSession.dispatch(this, message.session); break;
                case 'session': this.session = message.session; this.onSession.dispatch(this, message.session); break;
                case 'connectionHealth':
                    this.health = {players:message.players, timeoutMs:message.timeoutMs};
                    for (const value of message.players) {
                        const client = this.session?.clients.find(client => client.id === value.clientId);
                        if (client && value.ping !== null) client.ping = value.ping;
                    }
                    this.emitConnectionHealth(); break;
                case 'chat': this.onChat.dispatch(this, message); break;
                case 'message': this.onMessage.dispatch(this, message); break;
                case 'ping': this.connection.sendImmediate({ type: 'pong', t: message.t }); break;
                case 'error': {
                    const description = ERRORS[message.code];
                    const error = new LobbyConnectionError(message.code, message.code === 'invalidPacket' && message.message
                        ? `${description} ${message.message}. Please report this detail if it repeats.`
                        : description ?? message.message ?? message.code);
                    if (message.code !== 'invalidCommand') {
                        this.disconnectError = error;
                        this.match?.fail(error.message);
                    }
                    const handshaking = Boolean(this.handshakeReject);
                    this.handshakeReject?.(error);
                    if (handshaking) this.close();
                    this.onError.dispatch(this, error); break;
                }
                case 'startGame': {
                    clearInterval(this.healthTimer); this.healthTimer = undefined;
                    if (this.clientId === undefined || !this.session || this.match) throw new Error('Unexpected game start.');
                    const local = message.humanAssignments.find(item => item.clientId === this.clientId);
                    if (!local) throw new Error('The server did not assign a local player.');
                    this.match = new NetworkMatchSession(this.connection, message, {
                        kind: 'lan', roomId: message.gameId, gameId: message.gameId, timestamp: message.timestamp,
                        hostPeerId: String(this.session.clients.find(item => item.admin)?.id ?? this.clientId),
                        localPeerId: String(this.clientId), localPlayerName: local.name, gameOpts: message.gameOpts,
                        humanAssignments: message.humanAssignments.map(item => ({ peerId: String(item.clientId), slotIndex: item.slotIndex, name: item.name })),
                        mapTransferStateByPeerId: {}, returnRoute: { screenType: 0 },
                    });
                    this.onStartGame.dispatch(this, message); break;
                }
            }
        } catch (error) {
            const failure = new LobbyConnectionError('invalidMessage', error instanceof Error ? error.message : String(error));
            this.handshakeReject?.(failure); this.match?.fail(failure.message); this.onError.dispatch(this, failure);
        }
    };
}
