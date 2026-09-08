import { expect, test } from 'bun:test';
import { NodeWsTransport } from './NodeWsTransport';
import { GameServer } from '../src/network/server/GameServer';
import { LobbyClient } from '../src/network/client/LobbyClient';
import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from '../src/network/server/Protocol';
const identity = { protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine: 'ra2' as const, version: 'test', mod: 'ra2', modHash: 'rules', assetFingerprint: 'retail' };
async function until(condition: () => boolean) {
    const end = Date.now() + 5000;
    while (!condition()) { if (Date.now() > end) throw new Error('Condition timed out'); await Bun.sleep(5); }
}

test('a real broken socket resumes the same commander and live match; explicit leave still drops immediately', async () => {
    const transport = new NodeWsTransport(0, '127.0.0.1');
    const server = new GameServer({ identity, dedicated: true, gameOpts: { gameSpeed: 3, maxSlots: 2, mapDigest: 'test', aiPlayers: [], humanPlayers: [] } as any }, transport);
    const host = new LobbyClient(); const guest = new LobbyClient();
    try {
        await server.start();
        await host.connect(`127.0.0.1:${transport.port}`, { type: 'hello', ...identity, name: 'Host' });
        await guest.connect(`127.0.0.1:${transport.port}`, { type: 'hello', ...identity, name: 'Guest' });
        host.command('ready', { ready: true, mapDigest: 'test' }); guest.command('ready', { ready: true, mapDigest: 'test' });
        await until(() => server.session.clients.every(client => client.ready));
        host.command('startgame'); await until(() => host.session?.state === 'started' && guest.session?.state === 'started');
        const match = guest.getMatchSession(); const id = guest.clientId;
        host.getMatchSession().reportLoadProgress(100); match.reportLoadProgress(100);
        await until(() => match.areAllPlayersLoaded());
        const errors: unknown[] = []; guest.onError.subscribe(error => errors.push(error));
        const chats: string[] = []; host.onChat.subscribe(chat => chats.push(chat.text));
        const sockets = [...(transport as any).listener.clients] as any[];
        sockets[1].terminate();
        await until(() => guest.connection.isReconnecting);
        expect(server.session.clients.find(client => client.id === id)?.role).toBe('player');
        guest.chat('queued during outage');
        match.submitLocalTurn(0, new Uint8Array());
        host.getMatchSession().submitLocalTurn(0, new Uint8Array());
        await until(() => !guest.connection.isReconnecting);
        await until(() => chats.includes('queued during outage'));
        expect(chats.filter(text => text === 'queued during outage')).toHaveLength(1);
        expect(guest.getMatchSession()).toBe(match);
        expect(guest.clientId).toBe(id);
        expect(match.fatalError).toBeUndefined(); expect(errors).toEqual([]);
        expect(server.session.clients).toHaveLength(2);
        expect(match.tryConsumeTurn(0)).toBeDefined();
        guest.close();
        await until(() => server.session.clients.length === 1);
        expect(server.session.clients[0].name).toBe('Host');
    } finally { guest.close(); host.close(); server.stop(); }
}, 10000);
