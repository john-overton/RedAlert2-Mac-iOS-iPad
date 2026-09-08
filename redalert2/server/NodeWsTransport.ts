import { RESUME_MAX_PACKET_BYTES } from '../src/network/ResumableChannel';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerConnection, ServerTransport } from '../src/network/server/ServerTransport';

/** The only Node-dependent layer: the game server itself is runtime-neutral. */
export class NodeWsTransport implements ServerTransport {
    private listener?: WebSocketServer;
    public port = 0;
    constructor(private readonly requestedPort = 1620, private readonly host = '0.0.0.0') {}

    listen(onConnection: (connection: ServerConnection) => void): Promise<void> {
        if (this.listener) throw new Error('Server is already listening.');
        return new Promise((resolve, reject) => {
            const listener = this.listener = new WebSocketServer({
                port: this.requestedPort, host: this.host,
                maxPayload: RESUME_MAX_PACKET_BYTES, perMessageDeflate: false,
            });
            listener.once('error', reject);
            listener.once('listening', () => {
                const address = listener.address();
                this.port = typeof address === 'object' && address ? address.port : this.requestedPort;
                listener.removeListener('error', reject);
                resolve();
            });
            // A listener error must not become an uncaught exception in Electron.
            listener.on('error', (error) => console.error('[multiplayer] listener:', error.message));
            listener.on('connection', (socket, request) => {
                socket.on('error', () => socket.terminate());
                onConnection({
                    remoteAddress: request.socket.remoteAddress ?? '',
                    send: (data) => {
                        if (socket.readyState !== WebSocket.OPEN) return;
                        // A suspended/unresponsive client must not grow the main process indefinitely.
                        if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
                        socket.send(data);
                    },
                    close: (reason) => {
                        socket.close(1000, (reason ?? '').slice(0, 100));
                        const timer = setTimeout(() => socket.terminate(), 1000);
                        timer.unref();
                        socket.once('close', () => clearTimeout(timer));
                    },
                    onMessage: (handler) => {
                        socket.on('message', (data, binary) => {
                            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
                            handler(binary ? new Uint8Array(bytes) : bytes.toString('utf8'));
                        });
                    },
                    onClose: (handler) => { socket.once('close', () => handler()); },
                });
            });
        });
    }

    close(): void {
        const listener = this.listener;
        this.listener = undefined;
        if (!listener) return;
        for (const socket of listener.clients) socket.terminate();
        listener.close();
    }
}
