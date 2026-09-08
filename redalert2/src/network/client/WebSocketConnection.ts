import { EventDispatcher } from '@/util/event';

export const DEFAULT_GAME_PORT = 1620;

/** Parse direct-connect addresses without accepting credentials or unrelated URLs. */
export function parseServerAddress(address: string): string {
    const input = address.trim();
    if (!input) throw new Error('Enter a server address.');
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input.replace(/^ra2:/i, 'ws:') : `ws://${input}`;
    const explicitPort = normalized.split('/')[2]?.match(/:(\d+)$/)?.[1];
    const url = new URL(normalized);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') {
        throw new Error('Use a host, host:port, [IPv6]:port, or ra2://host:port.');
    }
    if (!url.hostname) throw new Error('Enter a server address.');
    if (explicitPort !== undefined && (Number(explicitPort) < 1 || Number(explicitPort) > 65535)) throw new Error('Port must be between 1 and 65535.');
    if (!explicitPort && !url.port) url.port = String(DEFAULT_GAME_PORT);
    return url.toString();
}

export class WebSocketConnection {
    readonly onMessage = new EventDispatcher<this, string | Uint8Array>();
    readonly onClose = new EventDispatcher<this, string>();
    private socket?: WebSocket;
    private cancelConnect?: () => void;

    constructor(private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}

    connect(address: string): Promise<void> {
        if (this.socket) throw new Error('Already connected.');
        const socket = this.socket = this.createSocket(parseServerAddress(address));
        socket.binaryType = 'arraybuffer';
        return new Promise((resolve, reject) => {
            let opened = false;
            this.cancelConnect = () => { clearTimeout(timer); reject(new Error('Connection cancelled.')); };
            const timer = setTimeout(() => {
                reject(new Error('Connection timed out. Check the address and port.'));
                this.close();
            }, 15000);
            socket.onopen = () => {
                if (this.socket !== socket) return;
                opened = true; this.cancelConnect = undefined; clearTimeout(timer); resolve();
            };
            socket.onerror = () => {
                if (this.socket !== socket) return;
                clearTimeout(timer);
                if (!opened) {
                    reject(new Error('Could not connect to the game server. Check the address and port.'));
                    this.close();
                }
            };
            socket.onmessage = event => {
                if (this.socket !== socket) return;
                if (typeof event.data === 'string') this.onMessage.dispatch(this, event.data);
                else if (event.data instanceof ArrayBuffer) this.onMessage.dispatch(this, new Uint8Array(event.data));
            };
            socket.onclose = event => {
                clearTimeout(timer);
                if (this.socket !== socket) return;
                this.socket = undefined;
                this.cancelConnect = undefined;
                const reason = event.reason || 'Disconnected from the game server.';
                if (!opened) reject(new Error(reason));
                this.onClose.dispatch(this, reason);
            };
        });
    }

    sendImmediate(message: unknown): void { this.sendRaw(JSON.stringify(message)); }
    sendRaw(data: string | Uint8Array): void {
        if (this.socket?.readyState !== 1) throw new Error('Not connected to the game server.');
        this.socket.send(data as any);
    }
    close(): void {
        this.cancelConnect?.(); this.cancelConnect = undefined;
        const socket = this.socket; this.socket = undefined;
        socket?.close(1000, 'Left game');
    }
}
