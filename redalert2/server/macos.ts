// Compiled into a standalone ARM64 helper. The app owns stdin: EOF means quit.
import { networkInterfaces } from 'node:os';
import { GameServer, type GameServerOptions } from '../src/network/server/GameServer';
import { BunWsTransport } from './BunWsTransport';

let server: GameServer | undefined;
let transport: BunWsTransport | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server?.stop();
    transport?.close();
    process.exit(code);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.stdin.on('end', () => stop());
process.stdin.on('error', () => stop(1));

let input = '';
let configured = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
    if (configured) return;
    input += chunk;
    if (Buffer.byteLength(input) > 128 * 1024) {
        console.log(JSON.stringify({ error: 'Hosting options are too large.' }));
        stop(1);
        return;
    }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    configured = true;
    try {
        const options = JSON.parse(input.slice(0, newline)) as GameServerOptions & { port?: number };
        input = '';
        const port = options.port ?? 1620;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
        transport = new BunWsTransport(port);
        server = new GameServer({ ...options, dedicated: false }, transport);
        await server.start();
        const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(entries =>
            (entries ?? []).filter(entry => !entry.internal && entry.family === 'IPv4').map(entry => entry.address)))];
        console.log(JSON.stringify({ port: transport.port, addresses }));
        timer = setInterval(() => {
            server!.tick();
            if (server!.isStopped) stop();
        }, 250);
    } catch (error) {
        console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        stop(1);
    }
});
// A caller that never sends a configuration must not leave a helper behind.
setTimeout(() => { if (!configured) stop(1); }, 15000).unref();
