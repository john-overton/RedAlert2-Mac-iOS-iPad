import type { ServerConnection, ServerTransport, WireData } from '../src/network/server/ServerTransport';

type Peer = {
    message?: (data: WireData) => void;
    close?: () => void;
};
/** Bun's native WebSocket listener, useful for protocol smokes and headless hosts. */
export class BunWsTransport implements ServerTransport {
    private listener?: ReturnType<typeof Bun.serve<Peer>>;
    public port = 0;
    constructor(private readonly requestedPort = 1620, private readonly hostname = '0.0.0.0') {}
    listen(onConnection: (connection: ServerConnection) => void): void {
        if (this.listener) throw new Error('Server is already listening.');
        this.listener = Bun.serve<Peer>({
            port: this.requestedPort, hostname: this.hostname,
            fetch(request, server) {
                if (server.upgrade(request, { data: {} })) return;
                return new Response('Red Alert 2 game server', { status: 200 });
            },
            websocket: {
                maxPayloadLength: 128 * 1024,
                backpressureLimit: 1024 * 1024,
                closeOnBackpressureLimit: true,
                open(socket) {
                    onConnection({
                        remoteAddress: socket.remoteAddress,
                        send(data) { socket.send(data); },
                        close(reason) { socket.close(1000, reason.slice(0, 100)); },
                        onMessage(handler) { socket.data.message = handler; },
                        onClose(handler) { socket.data.close = handler; },
                    });
                },
                message(socket, message) { socket.data.message?.(typeof message === 'string' ? message : new Uint8Array(message)); },
                close(socket) { socket.data.close?.(); },
            },
        });
        this.port = this.listener.port!;
    }
    close(): void { this.listener?.stop(true); this.listener = undefined; }
}
