import { EventDispatcher } from '@/util/event';
import type { HelloMessage, ServerMessage, StartGameMessage } from '@/network/server/Protocol';
import type { Session } from '@/network/server/Session';
import { WebSocketConnection } from './WebSocketConnection';
import { NetworkMatchSession } from './NetworkMatchSession';

export class LobbyConnectionError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'LobbyConnectionError'; }
}

const ERRORS: Record<string, string> = {
    passwordRequired: 'This game requires a password.', passwordWrong: 'The password is incorrect.',
    gameStarted: 'This game has already started.', versionMismatch: 'The server is running a different game version.',
    modMismatch: 'The server uses different rules or a different mod.',
    assetMismatch: 'Your retail asset import differs from the server. Each player must import matching assets; retail files are never transferred.',
    protocolMismatch: 'The server uses an incompatible multiplayer protocol.', full: 'The game is full.',
    banned: 'You are banned from this server.', kicked: 'You were removed from the game.',
};

export class LobbyClient {
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

    constructor(readonly connection = new WebSocketConnection()) {
        connection.onMessage.subscribe(this.receive);
        connection.onClose.subscribe(this.closed);
    }
    async connect(address: string, hello: HelloMessage): Promise<void> {
        this.intentionalClose = false;
        await this.connection.connect(address);
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new LobbyConnectionError('timeout', 'The server did not complete the handshake.');
                this.handshakeReject?.(error); this.close();
            }, 15000);
            this.handshakeResolve = () => { clearTimeout(timer); this.handshakeResolve = undefined; this.handshakeReject = undefined; resolve(); };
            this.handshakeReject = error => { clearTimeout(timer); this.handshakeResolve = undefined; this.handshakeReject = undefined; reject(error); };
            try { this.connection.sendImmediate({ ...hello, type: 'hello' }); }
            catch (error) { this.handshakeReject?.(error as Error); }
        });
    }
    command(name: string, args?: Record<string, unknown>): void { this.connection.sendImmediate({ type: 'command', name, args }); }
    chat(text: string, to: 'all' | 'team' | number = 'all'): void { this.connection.sendImmediate({ type: 'chat', to, text }); }
    getMatchSession(): NetworkMatchSession {
        if (!this.match) throw new Error('The game has not started.');
        return this.match;
    }
    close(): void {
        this.intentionalClose = true;
        this.handshakeReject?.(new Error('Connection cancelled.'));
        this.match?.dispose(); this.match = undefined;
        this.connection.close(); this.session = undefined; this.clientId = undefined;
    }
    private readonly closed = (reason: string) => {
        const error = new LobbyConnectionError('disconnected', reason);
        this.handshakeReject?.(error);
        if (!this.intentionalClose) this.onError.dispatch(this, error);
    };
    private readonly receive = (data: string | Uint8Array) => {
        if (typeof data !== 'string') return;
        try {
            const message: ServerMessage = JSON.parse(data);
            switch (message.type) {
                case 'welcome':
                    this.clientId = message.clientId; this.session = message.session;
                    this.handshakeResolve?.(); this.onSession.dispatch(this, message.session); break;
                case 'session': this.session = message.session; this.onSession.dispatch(this, message.session); break;
                case 'chat': this.onChat.dispatch(this, message); break;
                case 'message': this.onMessage.dispatch(this, message); break;
                case 'ping': this.connection.sendImmediate({ type: 'pong', t: message.t }); break;
                case 'error': {
                    const error = new LobbyConnectionError(message.code, ERRORS[message.code] ?? message.message ?? message.code);
                    const handshaking = Boolean(this.handshakeReject);
                    this.handshakeReject?.(error);
                    if (handshaking) this.close();
                    this.onError.dispatch(this, error); break;
                }
                case 'startGame': {
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
