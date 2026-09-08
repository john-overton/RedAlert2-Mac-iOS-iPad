import { HANDSHAKE_TIMEOUT_MS } from '../ConnectionHealth';
import { RESUME_GRACE_MS, RESUME_MAX_PACKET_BYTES, ResumableChannel } from '../ResumableChannel';
import type { ServerConnection, WireData } from './ServerTransport';

/** A private bearer token resumes the existing connection; it never admits a new commander. */
export class ResumableConnections {
    private readonly sessions = new Map<string, ResumableConnection>();
    private readonly pending = new Map<ServerConnection, ReturnType<typeof setTimeout>>();
    constructor(private readonly acceptSession: (connection: ServerConnection) => void, private readonly graceMs = RESUME_GRACE_MS) {}
    accept(socket: ServerConnection): void {
        if (this.pending.size + this.sessions.size >= 48) { socket.close('Server unavailable'); return; }
        let closed = false;
        const timer = setTimeout(() => { closed = true; this.pending.delete(socket); socket.close('Handshake timed out'); }, HANDSHAKE_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.(); this.pending.set(socket, timer);
        socket.onClose(() => { closed = true; clearTimeout(timer); this.pending.delete(socket); });
        let first = true;
        let session: ResumableConnection | undefined;
        let legacy: ((data: WireData) => void) | undefined;
        socket.onMessage(data => {
            if (closed) return;
            if (!first) { if (legacy) legacy(data); else session?.receive(socket, data); return; }
            first = false; clearTimeout(timer); this.pending.delete(socket);
            try {
                if (typeof data !== 'string' || new TextEncoder().encode(data).length > RESUME_MAX_PACKET_BYTES) throw new Error('Invalid recovery handshake size.');
                const message = JSON.parse(data);
                if (message?.type === 'transportResume') {
                    session = typeof message.token === 'string' ? this.sessions.get(message.token) : undefined;
                    if (!session) throw new Error('Recovery expired. Your commander can no longer be resumed.');
                    session.attach(socket, message.received);
                } else if (message?.type === 'hello' && message.transportResume === true) {
                    const token = crypto.randomUUID() + crypto.randomUUID();
                    session = new ResumableConnection(socket, token, () => this.sessions.delete(token), this.graceMs);
                    this.sessions.set(token, session);
                    this.acceptSession(session);
                    session.attach(socket, 0);
                    session.deliver(data);
                } else {
                    // Legacy/raw protocol tools remain usable, without recovery guarantees.
                    this.acceptSession({ remoteAddress: socket.remoteAddress, send: data => socket.send(data), close: reason => socket.close(reason), onMessage: handler => { legacy = handler; }, onClose: handler => socket.onClose(handler) });
                    legacy?.(data);
                }
            } catch (error) { socket.close(error instanceof Error ? error.message : 'Invalid recovery handshake'); }
        });
    }
    close(): void {
        for (const [socket, timer] of this.pending) { clearTimeout(timer); socket.close('Server closed'); }
        this.pending.clear();
        for (const session of [...this.sessions.values()]) session.close('Server closed');
    }
}
class ResumableConnection implements ServerConnection {
    readonly remoteAddress: string;
    private socket?: ServerConnection;
    private detachedSocket?: ServerConnection;
    private expired = false;
    private deadline = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private messageHandler: (data: WireData) => void = () => {};
    private closeHandler: () => void = () => {};
    private readonly channel = new ResumableChannel(data => this.deliver(data));
    constructor(socket: ServerConnection, private readonly token: string, private readonly remove: () => void, private readonly graceMs: number) { this.remoteAddress = socket.remoteAddress; }
    attach(socket: ServerConnection, received: unknown): void {
        if (this.expired || (this.deadline && Date.now() >= this.deadline)) { this.close('Connection recovery expired.'); throw new Error('Connection recovery expired.'); }
        this.channel.acknowledge(received);
        const previous = this.socket ?? this.detachedSocket;
        this.detachedSocket = undefined;
        this.socket = socket; this.deadline = 0; clearTimeout(this.timer);
        if (previous && previous !== socket) previous.close('Connection replaced');
        socket.onClose(() => this.suspend(socket));
        try {
            socket.send(JSON.stringify({ type: 'transportReady', token: this.token, received: this.channel.received }));
            for (const packet of this.channel.replay()) socket.send(packet);
        } catch { this.suspend(socket); }
    }
    private suspend(socket: ServerConnection): void {
        if (this.socket !== socket || this.expired) return;
        this.socket = undefined; this.detachedSocket = socket;
        this.deadline = Date.now() + this.graceMs;
        this.timer = setTimeout(() => this.close('Connection recovery expired.'), this.graceMs);
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }
    private write(data: WireData): void {
        const socket = this.socket;
        if (!socket) return;
        try { socket.send(data); } catch { this.suspend(socket); }
    }
    receive(socket: ServerConnection, data: WireData): void {
        if (this.socket !== socket || this.expired) return;
        try {
            if (typeof data === 'string') {
                const message = JSON.parse(data);
                if (message.type === 'transportClose') { this.close('Left game'); return; }
                if (message.type !== 'transportAck') throw new Error('Invalid recovery control.');
                this.channel.acknowledge(message.received);
            } else {
                this.channel.receive(data);
                this.write(JSON.stringify({ type: 'transportAck', received: this.channel.received }));
            }
        } catch (error) { this.close(error instanceof Error ? error.message : 'Invalid recovery packet'); }
    }
    deliver(data: WireData): void { if (!this.expired) this.messageHandler(data); }
    send(data: WireData): void {
        if (this.expired) return;
        try { const packet = this.channel.encode(data); this.write(packet); }
        catch (error) { this.close(error instanceof Error ? error.message : 'Recovery failed'); }
    }
    close(reason: string): void {
        if (this.expired) return;
        this.expired = true; clearTimeout(this.timer); this.remove();
        const socket = this.socket; this.socket = undefined;
        socket?.close(reason); this.detachedSocket?.close(reason); this.detachedSocket = undefined; this.closeHandler();
    }
    onMessage(handler: (data: WireData) => void): void { this.messageHandler = handler; }
    onClose(handler: () => void): void { this.closeHandler = handler; }
}
