import { networkInterfaces } from 'node:os';
import { GameServer, type GameServerOptions } from '../src/network/server/GameServer';
import { NodeWsTransport } from './NodeWsTransport';

/** One owned listener per shell. The host connects through the same wire as guests. */
export async function hostGame(options: GameServerOptions & { port?: number }) {
    const port = options.port ?? 1620;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const transport = new NodeWsTransport(port);
    const server = new GameServer({ ...options, dedicated: false }, transport);
    try { await server.start(); }
    catch (error) { transport.close(); throw error; }
    const timer = setInterval(() => server.tick(), 1000);
    timer.unref();
    const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).filter((entry) => !entry.internal && entry.family === 'IPv4').map((entry) => entry.address));
    return {
        port: transport.port, addresses,
        get isStopped() { return server.isStopped; },
        stop() { clearInterval(timer); server.stop(); transport.close(); },
    };
}
