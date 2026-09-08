import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from '../redalert2/src/network/server/Protocol.ts';
// bun scripts/macos-host-smoke.ts [path/to/RA2Server]
// Real sockets against the standalone helper; no retail assets required.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { LobbyClient } from '../redalert2/src/network/client/LobbyClient';

const executable = process.argv[2] ?? fileURLToPath(new URL('../build/macos/yr/Red Alert 2.app/Contents/Helpers/RA2Server', import.meta.url));
const identity = { protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine: 'yr' as const, mod: 'base', version: 'mac-host-smoke', modHash: 'rules', assetFingerprint: 'retail' };
const gameOpts = { gameMode: 0, gameSpeed: 3, credits: 10000, unitCount: 0, shortGame: true, superWeapons: true, buildOffAlly: true, mcvRepacks: true, cratesAppear: true, destroyableBridges: true, multiEngineer: false, noDogEngiKills: false, mapName: 'test.map', mapTitle: 'Test Map', mapDigest: 'digest', mapSizeBytes: 100, maxSlots: 4, mapOfficial: true, humanPlayers: [], aiPlayers: [] };
const children: ReturnType<typeof spawn>[] = [];
const clients: LobbyClient[] = [];
async function freePort() {
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as any).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    return port;
}
async function start(port: number) {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    const exited = once(child, 'exit');
    let output = '';
    const result = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Helper startup timed out')), 15000);
        child.once('error', reject);
        child.stdout!.on('data', data => {
            output += data;
            if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0])); }
        });
        child.once('exit', () => { clearTimeout(timeout); if (!output.includes('\n')) reject(new Error('Helper exited without a result')); });
    });
    child.stdin!.write(JSON.stringify({ identity, gameOpts, port, password: 'secret' }) + '\n');
    return { child, exited, result: await result };
}
async function join(port: number, name: string, password = 'secret') {
    const client = new LobbyClient(); clients.push(client);
    await client.connect(`127.0.0.1:${port}`, { ...identity, type: 'hello', name, password });
    return client;
}
async function until(check: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for session update'); await Bun.sleep(10); }
}
try {
    const port = await freePort();
    const hosted = await start(port);
    assert.equal(hosted.result.port, port); assert.ok(Array.isArray(hosted.result.addresses));
    const collision = await start(port); assert.ok(collision.result.error); await collision.exited;
    const invalid = await start(65536); assert.match(invalid.result.error, /Port/); await invalid.exited;
    await assert.rejects(join(port, 'Wrong password', 'wrong'));
    const host = await join(port, 'Mac Host');
    const guest = await join(port, 'Guest');
    await until(() => host.session?.clients.length === 2);
    const messages: any[] = []; guest.onChat.subscribe(message => messages.push(message));
    host.chat('Mac host online', 'all');
    await until(() => messages.length > 0); assert.equal(messages[0].text, 'Mac host online');
    const files = [{path:'custom.map',bytes:new Uint8Array(50000).fill(7)},
        {path:'rules.ini',bytes:new TextEncoder().encode('[MTNK]\nStrength=800')}];
    const manifest = await host.publishContent(files);
    await until(() => guest.session?.content?.id === manifest.id);
    assert.deepEqual(await guest.downloadContent(manifest), files);
    const cleared = await host.publishContent([]);
    await until(() => guest.session?.content?.id === cleared.id);
    host.contentReady(cleared.id); guest.contentReady(cleared.id);
    console.log('Custom map and unit content delivery passed.');
    host.command('map_ready', { digest: 'digest' });
    guest.command('state', { ready: true, mapDigest: 'digest' });
    await until(() => host.session!.clients.some(client => client.name === 'Guest' && client.ready));
    host.command('startgame');
    await until(() => host.session!.state === 'started' && guest.session!.state === 'started');
    const firstHostMatch = host.getMatchSession(), firstGuestMatch = guest.getMatchSession();
    const originalIds = host.session!.clients.map(client => client.id);
    const originalSlots = structuredClone(host.session!.slots);
    const originalOptions = structuredClone(host.session!.gameOpts);
    firstHostMatch.reportLoadProgress(100); firstGuestMatch.reportLoadProgress(100);
    await until(() => firstHostMatch.areAllPlayersLoaded() && firstGuestMatch.areAllPlayersLoaded());
    host.returnToLobby('forfeit');
    await until(() => firstGuestMatch.getSnapshot().suspectedDropPeerIds.includes(String(host.clientId)));
    assert.equal(hosted.child.exitCode, null); assert.equal(hosted.child.signalCode, null);
    assert.equal(guest.session!.state, 'started');
    assert.equal(guest.getMatchSession(), firstGuestMatch);
    assert.throws(() => host.getMatchSession(), /not started/);
    guest.returnToLobby('finished');
    await until(() => host.session!.state === 'waiting' && guest.session!.state === 'waiting');
    assert.ok(host.session!.clients.every(client => !client.ready && client.loaded === 0));
    assert.deepEqual(host.session!.clients.map(client => client.id), originalIds);
    assert.deepEqual(host.session!.slots, originalSlots);
    assert.deepEqual(host.session!.gameOpts, originalOptions);
    assert.equal(host.session!.content!.id, cleared.id);
    host.contentReady(cleared.id); guest.contentReady(cleared.id);
    host.command('map_ready', { digest: 'digest' });
    guest.command('state', { ready: true, mapDigest: 'digest' });
    await until(() => host.session!.clients.some(client => client.name === 'Guest' && client.ready));
    host.command('startgame');
    await until(() => host.session!.state === 'started' && guest.session!.state === 'started');
    const secondHostMatch = host.getMatchSession(), secondGuestMatch = guest.getMatchSession();
    assert.notEqual(secondHostMatch, firstHostMatch); assert.notEqual(secondGuestMatch, firstGuestMatch);
    assert.equal(secondHostMatch.connection, firstHostMatch.connection);
    assert.equal(secondGuestMatch.connection, firstGuestMatch.connection);
    assert.equal(secondHostMatch.start.generation, firstHostMatch.start.generation + 1);
    assert.notEqual(secondHostMatch.start.gameId, firstHostMatch.start.gameId);
    assert.deepEqual(host.session!.clients.map(client => client.id), originalIds);
    secondHostMatch.reportLoadProgress(100); secondGuestMatch.reportLoadProgress(100);
    await until(() => secondHostMatch.areAllPlayersLoaded() && secondGuestMatch.areAllPlayersLoaded());
    secondHostMatch.submitLocalTurn(0, new Uint8Array()); secondGuestMatch.submitLocalTurn(0, new Uint8Array());
    await until(() => secondHostMatch.getSnapshot().bufferedTicks.includes(2) && secondGuestMatch.getSnapshot().bufferedTicks.includes(2));
    assert.equal(secondHostMatch.fatalError, undefined); assert.equal(secondGuestMatch.fatalError, undefined);
    host.close(); await hosted.exited;
    console.log('Host/guest, password rejection, chat, host forfeit, repeated rounds on original sockets and host departure passed.');
    const reused = await start(port); assert.equal(reused.result.port, port);
    reused.child.stdin!.end(); await reused.exited;
    const terminated = await start(port); assert.equal(terminated.result.port, port);
    terminated.child.kill('SIGTERM'); await terminated.exited;
    const final = await start(port); assert.equal(final.result.port, port);
    final.child.stdin!.end(); await final.exited;
    console.log('Port collision, invalid port, EOF/quit cleanup and immediate port reuse passed.');
} finally {
    for (const client of clients) client.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
