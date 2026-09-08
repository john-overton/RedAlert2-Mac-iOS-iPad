// bun scripts/lockstep-smoke.mjs [bun|node]
// Real sockets, delayed ordered delivery with deterministic retransmission stalls.
// WebSocket is reliable: simulate 2% packet loss as 200ms retransmission delay,
// never by deleting application frames (which TCP would eventually retransmit).
import assert from 'node:assert/strict';
import { GameServer } from '../redalert2/src/network/server/GameServer.ts';
import { BunWsTransport } from '../redalert2/server/BunWsTransport.ts';
import { NodeWsTransport } from '../redalert2/server/NodeWsTransport.ts';
import { LobbyClient } from '../redalert2/src/network/client/LobbyClient.ts';
import { WebSocketConnection } from '../redalert2/src/network/client/WebSocketConnection.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
    const deadline = Date.now() + 15000;
    while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(5); }
}
const identity = { protocol: 1, ordersProtocol: 2, engine: 'ra2', mod: 'base', version: 'socket-smoke', modHash: 'rules', assetFingerprint: 'retail-crc' };
const gameOpts = { gameMode: 0, gameSpeed: 3, credits: 10000, unitCount: 0, shortGame: true, superWeapons: true, buildOffAlly: true, mcvRepacks: true, cratesAppear: true, destroyableBridges: true, multiEngineer: false, noDogEngiKills: false, mapName: 'test.map', mapTitle: 'Protocol Smoke', mapDigest: 'digest', mapSizeBytes: 100, maxSlots: 4, mapOfficial: true, humanPlayers: [], aiPlayers: [] };
const transport = process.argv[2] === 'node' ? new NodeWsTransport(0, '127.0.0.1') : new BunWsTransport(0, '127.0.0.1');
const server = new GameServer({ identity, gameOpts, password: 'secret', dedicated: true }, transport);
const clients = [];
const timer = setInterval(() => server.tick(), 1000);
try {
    await server.start();
    const address = `127.0.0.1:${transport.port}`;
    for (const [patch, code] of [[{ password: '' }, 'passwordRequired'], [{ password: 'wrong' }, 'passwordWrong'], [{ version: 'different' }, 'versionMismatch'], [{ modHash: 'different' }, 'modMismatch'], [{ assetFingerprint: 'different' }, 'assetMismatch'], [{ ordersProtocol: 99 }, 'protocolMismatch']]) {
        const rejected = new LobbyClient(); clients.push(rejected);
        await assert.rejects(rejected.connect(address, { ...identity, type: 'hello', name: 'Rejected', password: 'secret', ...patch }), error => error.code === code);
        rejected.close();
    }
    const a = new LobbyClient(), b = new LobbyClient(); clients.push(a, b);
    await a.connect(address, { ...identity, type: 'hello', name: 'Host', password: 'secret' });
    await b.connect(address, { ...identity, type: 'hello', name: 'Guest', password: 'secret' });
    a.command('slot_bot', { slotIndex: 2, difficulty: 0 });
    a.command('map_ready', { digest: 'digest' });
    b.command('state', { ready: true, mapDigest: 'digest' });
    await until(() => a.session?.clients.every(c => c.mapReady) && a.session?.clients.find(c => c.name === 'Guest')?.ready, 'ready lobby');
    a.command('startgame');
    await until(() => a.session?.state === 'started' && b.session?.state === 'started', 'start');
    const ma = a.getMatchSession(), mb = b.getMatchSession();
    ma.reportLoadProgress(100);
    await sleep(20); assert.equal(ma.areAllPlayersLoaded(), false);
    mb.reportLoadProgress(100);
    await until(() => ma.areAllPlayersLoaded() && mb.areAllPlayersLoaded(), 'load gate');
    let sent = 0, retransmissions = 0, chain = Promise.resolve();
    const send = b.connection.sendRaw.bind(b.connection);
    b.connection.sendRaw = data => {
        const lost = ++sent % 50 === 0; if (lost) retransmissions++;
        // Preserve TCP order while imposing 200ms one-way delay.
        const due = sleep(200 + (lost ? 200 : 0));
        chain = chain.then(async () => { await due; send(data); });
    };
    const histories = [[], []];
    const run = async (match, index) => {
        for (let tick = 0; tick < 100; tick++) {
            match.submitLocalTurn(tick, new Uint8Array([index + 1, tick]));
            let turn;
            await until(() => Boolean(turn = match.tryConsumeTurn(tick)), `client ${index} tick ${tick}`);
            const encoded = turn.batches.map(batch => [...batch.actionData]);
            histories[index].push(encoded);
            match.sendSync(tick, tick * 101);
        }
    };
    await Promise.all([run(ma, 0), run(mb, 1)]);
    await chain;
    assert.deepEqual(histories[0], histories[1]);
    assert.deepEqual(histories[0][0], [[], []]);
    assert.deepEqual(histories[0][2], [[1, 0], [2, 0]]);
    // Deliberate disagreement must identify the same frame on both clients.
    ma.submitLocalTurn(100, new Uint8Array()); mb.submitLocalTurn(100, new Uint8Array());
    ma.sendSync(100, 1); mb.sendSync(100, 2);
    await until(() => ma.fatalError && mb.fatalError, 'desync stop');
    assert.equal(ma.fatalError.frame, 101); assert.equal(mb.fatalError.frame, 101);
    assert.equal(ma.tryConsumeTurn(100), undefined); assert.equal(mb.tryConsumeTurn(100), undefined);
    console.log(JSON.stringify({ transport: process.argv[2] ?? 'bun', matchedFrames: 100, oneWayDelayMs: 200, retransmissions, rejectedHandshakes: 6, mismatchFrame: 101 }));
} finally {
    clients.forEach(client => client.close());
    clearInterval(timer); server.stop();
}
