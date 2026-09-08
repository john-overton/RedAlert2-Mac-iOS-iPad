import { RESUME_GRACE_MS, ResumableChannel } from '../ResumableChannel';
import { HANDSHAKE_TIMEOUT_MS } from '../ConnectionHealth';
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
    readonly onReconnecting = new EventDispatcher<this, boolean>();
    private socket?: WebSocket;
    private cancelConnect?: () => void;
    private address = '';
    private token?: string;
    private channel?: ResumableChannel;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private recoveryTimer?: ReturnType<typeof setTimeout>;
    private recoveryDeadline = 0;
    private ready = false;
    private intentionalClose = false;
    get isReconnecting(): boolean { return this.recoveryDeadline > 0; }

    /** Local transport state only; bufferedAmount is not a latency measurement. */
    getPerformanceSnapshot() {
        return {
            reconnecting: this.isReconnecting,
            ready: this.ready,
            socketReadyState: this.socket?.readyState ?? null,
            browserSendQueueBytes: this.socket?.bufferedAmount ?? 0,
        };
    }

    constructor(private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}

    connect(address: string): Promise<void> {
        if (this.socket || this.isReconnecting) throw new Error('Already connected.');
        this.address = parseServerAddress(address);
        this.intentionalClose = false; this.token = undefined; this.channel = undefined;
        return this.open(false);
    }
    private open(recovering: boolean): Promise<void> {
        const socket = this.socket = this.createSocket(this.address);
        socket.binaryType = 'arraybuffer'; this.ready = false;
        return new Promise((resolve, reject) => {
            let opened = false;
            this.cancelConnect = () => { clearTimeout(timer); reject(new Error('Connection cancelled.')); };
            const timer = setTimeout(() => {
                reject(new Error('Connection timed out. Check the address and port.'));
                if (recovering) { this.detach(socket); this.retry(); } else this.close();
            }, recovering ? Math.min(5000, Math.max(1, this.recoveryDeadline - Date.now())) : HANDSHAKE_TIMEOUT_MS);
            socket.onopen = () => {
                if (this.socket !== socket) return;
                opened = true;
                if (recovering) {
                    try { socket.send(JSON.stringify({ type: 'transportResume', token: this.token, received: this.channel!.received })); }
                    catch (error) { clearTimeout(timer); this.detach(socket); this.retry(); reject(error); }
                }
                else { this.ready = true; this.cancelConnect = undefined; clearTimeout(timer); resolve(); }
            };
            socket.onerror = () => {
                if (this.socket !== socket || opened) return;
                clearTimeout(timer);
                reject(new Error('Could not connect to the game server. Check the address and port.'));
                if (recovering) { this.detach(socket); this.retry(); } else this.close();
            };
            socket.onmessage = event => {
                if (this.socket !== socket) return;
                try {
                    if (typeof event.data === 'string') {
                        const control = JSON.parse(event.data);
                        if (control.type === 'transportReady') {
                            if (typeof control.token !== 'string' || !control.token.length || control.token.length > 200 || (this.token && this.token !== control.token)) throw new Error('Invalid recovery identity.');
                            this.token = control.token;
                            this.channel ??= new ResumableChannel(data => this.onMessage.dispatch(this, data));
                            this.channel.acknowledge(control.received);
                            this.ready = true;
                            try { for (const packet of this.channel.replay()) socket.send(packet as any); }
                            catch (error) { clearTimeout(timer); this.detach(socket); this.retry(); reject(error); return; }
                            this.cancelConnect = undefined; clearTimeout(timer); clearTimeout(this.recoveryTimer);
                            this.recoveryDeadline = 0;
                            if (recovering) this.onReconnecting.dispatch(this, false);
                            resolve(); return;
                        }
                        if (this.channel) {
                            if (control.type !== 'transportAck') throw new Error('Invalid recovery control.');
                            this.channel.acknowledge(control.received); return;
                        }
                        this.onMessage.dispatch(this, event.data);
                    } else if (event.data instanceof ArrayBuffer) {
                        const data = new Uint8Array(event.data);
                        if (this.channel) {
                            this.channel.receive(data);
                            if (this.socket === socket) {
                                try { socket.send(JSON.stringify({ type: 'transportAck', received: this.channel.received })); }
                                catch { clearTimeout(timer); this.detach(socket); this.retry(); }
                            }
                        } else this.onMessage.dispatch(this, data);
                    }
                } catch (error) { this.fail(error instanceof Error ? error.message : 'Invalid server message.'); }
            };
            socket.onclose = event => {
                clearTimeout(timer);
                if (this.socket !== socket) return;
                this.socket = undefined; this.ready = false; this.cancelConnect = undefined;
                const reason = event.reason || 'Disconnected from the game server.';
                if (!opened || recovering) reject(new Error(reason));
                if (this.token && event.code !== 1000 && !this.intentionalClose) this.retry();
                else this.fail(reason);
            };
        });
    }
    private detach(socket: WebSocket): void {
        if (this.socket !== socket) return;
        this.socket = undefined; this.ready = false; this.cancelConnect = undefined;
        socket.close();
    }
    private retry(): void {
        if (this.intentionalClose || !this.token) return;
        if (!this.recoveryDeadline) {
            this.recoveryDeadline = Date.now() + RESUME_GRACE_MS;
            this.onReconnecting.dispatch(this, true);
            this.recoveryTimer = setTimeout(() => this.fail('Connection recovery expired after 30 seconds. Your commander could not be resumed.'), RESUME_GRACE_MS);
        }
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (this.intentionalClose || !this.isReconnecting) return;
            try { void this.open(true).catch(() => {}); }
            catch { this.retry(); }
        }, 500);
    }
    private fail(reason: string): void {
        this.close(); this.onClose.dispatch(this, reason);
    }
    sendImmediate(message: unknown): void {
        // Negotiate recovery on the normal hello so raw protocol tooling still works.
        const value = message && typeof message === 'object' && (message as any).type === 'hello' ? { ...message, transportResume: true } : message;
        this.sendRaw(JSON.stringify(value));
    }
    sendRaw(data: string | Uint8Array): void {
        if (this.channel) {
            let packet: Uint8Array;
            try { packet = this.channel.encode(data); }
            catch (error) { this.fail(error instanceof Error ? error.message : 'Recovery buffer exceeded.'); throw error; }
            if (this.ready && this.socket?.readyState === 1) {
                try { this.socket.send(packet as any); }
                catch { this.detach(this.socket); this.retry(); }
            }
            return;
        }
        if (this.socket?.readyState !== 1) throw new Error('Not connected to the game server.');
        this.socket.send(data as any);
    }
    close(): void {
        this.intentionalClose = true;
        clearTimeout(this.retryTimer); clearTimeout(this.recoveryTimer); this.recoveryDeadline = 0;
        this.cancelConnect?.(); this.cancelConnect = undefined;
        const socket = this.socket; this.socket = undefined; this.ready = false;
        if (this.token && socket?.readyState === 1) {
            try { socket.send(JSON.stringify({ type: 'transportClose' })); } catch {}
        }
        this.token = undefined; this.channel = undefined;
        socket?.close(1000, 'Left game');
    }
}
