import { expect, test } from 'bun:test';
import { ResumableConnections } from './ResumableConnections';
import { ResumableChannel } from '../ResumableChannel';
import { GameServer } from './GameServer';
import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from './Protocol';
import type { ServerConnection, WireData } from './ServerTransport';

const identity = { protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine: 'ra2' as const, version: 'test', mod: 'ra2', modHash: 'rules', assetFingerprint: 'retail' };
class Socket implements ServerConnection {
    remoteAddress = '127.0.0.1';
    sent: WireData[] = [];
    closed?: string;
    throws = false;
    private incoming: (data: WireData) => void = () => {};
    private closing: (() => void)[] = [];
    send(data: WireData) { if (this.throws) throw new Error('Broken pipe'); this.sent.push(data); }
    close(reason: string) { if (this.closed) return; this.closed = reason; this.break(); }
    onMessage(handler: (data: WireData) => void) { this.incoming = handler; }
    onClose(handler: () => void) { this.closing.push(handler); }
    receive(data: WireData) { this.incoming(data); }
    break() { for (const handler of this.closing) handler(); }
    control(value: unknown) { this.receive(JSON.stringify(value)); }
    token() { return JSON.parse(this.sent.find(data => typeof data === 'string') as string).token; }
}
function fixture(dedicated = true) {
    const server = new GameServer({ identity, dedicated, gameOpts: { gameSpeed: 3, maxSlots: 2, mapDigest: 'map', disconnectAi: true, aiPlayers: [], humanPlayers: [] } as any });
    const manager = new ResumableConnections(connection => server.accept(connection), 25);
    function join(name: string) {
        const socket = new Socket(); const received: any[] = [];
        const channel = new ResumableChannel(data => { if (typeof data === 'string') received.push(JSON.parse(data)); });
        let read = 0;
        const drain = (source = socket) => {
            for (const data of source.sent.slice(read)) if (data instanceof Uint8Array) channel.receive(data);
            read = source.sent.length;
        };
        const command = (name: string, args?: unknown) => socket.receive(channel.encode(JSON.stringify({ type: 'command', name, args })));
        manager.accept(socket); socket.control({ type: 'hello', transportResume: true, ...identity, name }); drain();
        return { socket, channel, command, drain, received, token: socket.token() };
    }
    return { server, manager, join, close: () => { manager.close(); server.stop(); } };
}

test('a detached lobby commander retains customization and the embedded host can resume without closing the server', () => {
    const f = fixture(false);
    try {
        const host = f.join('Host'); const guest = f.join('Guest');
        host.command('player', { countryId: 2, colorId: 3, teamId: 1 });
        const before = f.server.session.clients;
        host.socket.break();
        expect(f.server.isStopped).toBe(false);
        const replacement = new Socket(); f.manager.accept(replacement);
        replacement.control({ type: 'transportResume', token: host.token, received: host.channel.received });
        expect(replacement.closed).toBeUndefined();
        expect(f.server.session.clients).toEqual(before);
        expect(f.server.isStopped).toBe(false);
        replacement.control({ type: 'transportClose' });
        expect(f.server.isStopped).toBe(true);
        expect(guest.socket.closed).toBe('Server closed');
    } finally { f.close(); }
});

test('only grace expiry removes a detached commander and schedules the configured AI takeover', async () => {
    const f = fixture();
    try {
        const host = f.join('Host'); const guest = f.join('Guest');
        host.command('ready', { ready: true, mapDigest: 'map' }); guest.command('ready', { ready: true, mapDigest: 'map' }); host.command('startgame');
        const session = f.server.session;
        for (const client of [host, guest]) client.socket.receive(client.channel.encode(JSON.stringify({ type: 'loaded', gameId: session.gameId, generation: session.generation, percent: 100 })));
        guest.socket.break(); host.drain();
        expect(f.server.session.clients).toHaveLength(2);
        expect(host.received.some(message => message.type === 'disconnect')).toBe(false);
        await Bun.sleep(40); host.drain();
        expect(f.server.session.clients).toHaveLength(1);
        expect(host.received.filter(message => message.type === 'disconnect')).toEqual([{ type: 'disconnect', generation: 1, clientId: 2, frame: 3, takeover: 'ai' }]);
        const expired = new Socket(); f.manager.accept(expired); expired.control({ type: 'transportResume', token: guest.token, received: 0 });
        expect(expired.closed).toContain('expired');
    } finally { f.close(); }
});

test('forged resume tokens and impossible acknowledgements cannot replace a commander', () => {
    const f = fixture();
    try {
        const host = f.join('Host');
        for (const message of [ { type: 'transportResume', token: 'guessed', received: 0 }, { type: 'transportResume', token: host.token, received: 0xffffffff } ]) {
            const attacker = new Socket(); f.manager.accept(attacker); attacker.control(message);
            expect(attacker.closed).toBeDefined();
        }
        expect(host.socket.closed).toBeUndefined();
        expect(f.server.session.clients).toHaveLength(1);
        host.command('ready', { ready: true, mapDigest: 'map' });
        expect(f.server.session.clients[0].ready).toBe(true);
    } finally { f.close(); }
});

test('kicking a detached commander invalidates recovery immediately', () => {
    const f = fixture();
    try {
        const host = f.join('Host'); const guest = f.join('Guest');
        host.command('ready', { ready: true, mapDigest: 'map' }); guest.command('ready', { ready: true, mapDigest: 'map' }); host.command('startgame');
        const session = f.server.session;
        for (const client of [host, guest]) client.socket.receive(client.channel.encode(JSON.stringify({ type: 'loaded', gameId: session.gameId, generation: session.generation, percent: 100 })));
        guest.socket.break(); host.command('kick_ai', { clientId: 2, generation: session.generation, gameId: session.gameId });
        expect(f.server.session.clients).toHaveLength(1);
        const retry = new Socket(); f.manager.accept(retry); retry.control({ type: 'transportResume', token: guest.token, received: 0 });
        expect(retry.closed).toContain('expired');
    } finally { f.close(); }
});

test('a physical send failure retains its packet and resumes without an application disconnect', () => {
    let logical: ServerConnection;
    let closes = 0;
    const manager = new ResumableConnections(connection => { logical = connection; connection.onMessage(() => {}); connection.onClose(() => closes++); });
    try {
        const first = new Socket(); manager.accept(first); first.control({ type: 'hello', transportResume: true });
        first.throws = true; logical!.send('retain me');
        expect(closes).toBe(0);
        const retry = new Socket(); manager.accept(retry); retry.control({ type: 'transportResume', token: first.token(), received: 0 });
        const received: unknown[] = []; const channel = new ResumableChannel(value => received.push(value));
        for (const data of retry.sent) if (data instanceof Uint8Array) channel.receive(data);
        expect(received).toEqual(['retain me']); expect(closes).toBe(0);
    } finally { manager.close(); }
});
