import { CONNECTION_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS } from '../ConnectionHealth';
import { expect, test } from 'bun:test';
import { GameServer } from './GameServer';
import { decodePacket, encodeOrderPacket as encodeOrders, encodeSyncPacket as encodeSync, encodeRelayedSyncPacket as encodeRelay, HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from './Protocol';
import type { HelloMessage, ServerMessage } from './Protocol';
import type { GameOpts } from '../../game/gameopts/GameOpts';
import type { ServerConnection, WireData } from './ServerTransport';

const encodeOrderPacket = (id: number, frame: number, actions: Uint8Array, generation = 1) => encodeOrders(id, frame, actions, generation);
const encodeSyncPacket = (frame: number, hash: number, mask = 0n, generation = 1) => encodeSync(frame, hash, mask, generation);
const encodeRelayedSyncPacket = (id: number, frame: number, hash: number, mask = 0n, generation = 1) => encodeRelay(id, frame, hash, mask, generation);
class Connection implements ServerConnection {
    remoteAddress = '127.0.0.1';
    messages: WireData[] = [];
    closed?: string;
    receive: (data: WireData) => void = () => {};
    closeHandler: () => void = () => {};
    send(data: WireData) { this.messages.push(data); }
    close(reason: string) { this.closed = reason; this.closeHandler(); }
    onMessage(handler: (data: WireData) => void) { this.receive = handler; }
    onClose(handler: () => void) { this.closeHandler = handler; }
    json(message: any) {
        if (message.type === 'loaded' || message.type === 'returnToLobby' || (message.type === 'command' && message.name === 'kick_ai')) {
            const match = this.all('startGame').at(-1);
            if (match) {
                if (message.type === 'command') message = { ...message, args: { gameId: match.gameId, generation: match.generation, ...message.args } };
                else message = { gameId: match.gameId, generation: match.generation, ...message };
            }
        }
        this.receive(JSON.stringify(message));
    }
    command(name: string, args: Record<string, unknown> = {}) {
        if (name === 'observe') { const session = this.all('session').at(-1)?.session; args = { gameId: session?.gameId, generation: session?.generation, ...args }; }
        this.json({ type: 'command', name, args });
    }
    all(type: string): any[] { return this.messages.filter(m => typeof m === 'string').map(m => JSON.parse(m as string)).filter(m => m.type === type); }
    packets() { return this.messages.filter(m => m instanceof Uint8Array).map(m => decodePacket(m as Uint8Array)); }
}
const identity = { protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine: 'ra2' as const, mod: 'base', version: 'test', modHash: 'rules', assetFingerprint: 'retail' };
const gameOpts: GameOpts = { gameMode: 0, gameSpeed: 3, credits: 10000, unitCount: 0, shortGame: true, superWeapons: true, buildOffAlly: true, mcvRepacks: true, cratesAppear: true, destroyableBridges: true, multiEngineer: false, noDogEngiKills: false, mapName: 'test.map', mapTitle: 'Test Map', mapDigest: 'digest', mapSizeBytes: 100, maxSlots: 4, mapOfficial: true, humanPlayers: [], aiPlayers: [] };
function setup(extra: Record<string, unknown> = {}) {
    let time = 1000;
    const server = new GameServer({ identity, gameOpts, dedicated: true, now: () => time, ...extra });
    const join = (name: string, override: Partial<HelloMessage> = {}) => {
        const connection = new Connection(); server.accept(connection);
        connection.json({ ...identity, type: 'hello', name, ...override });
        return connection;
    };
    const start = () => {
        const a = join('Host'); const b = join('Guest');
        a.command('map_ready', { digest: 'digest' }); b.command('state', { ready: true, mapDigest: 'digest' });
        a.command('startgame'); a.json({ type: 'loaded', percent: 100 }); b.json({ type: 'loaded', percent: 100 });
        return { a, b };
    };
    return { server, join, start, advance: (delta: number) => { time += delta; server.tick(time); } };
}

test('handshake rejects password, mod, build, assets and protocol in specified order', () => {
    const { join } = setup({ password: 'secret' });
    expect(join('a').all('error')[0].code).toBe('passwordRequired');
    expect(join('a', { password: 'bad', version: 'bad' }).all('error')[0].code).toBe('passwordWrong');
    expect(join('a', { password: 'secret', modHash: 'bad', version: 'bad' }).all('error')[0].code).toBe('modMismatch');
    expect(join('a', { password: 'secret', version: 'bad' }).all('error')[0].code).toBe('versionMismatch');
    expect(join('a', { password: 'secret', assetFingerprint: 'bad' }).all('error')[0].code).toBe('assetMismatch');
    expect(join('a', { password: 'secret', ordersProtocol: 99 }).all('error')[0].code).toBe('protocolMismatch');
    const good = join('a', { password: 'secret' });
    expect(good.all('welcome')[0].session.clients[0].admin).toBe(true);
});

test('lobby enforces ownership, map availability, readiness and authoritative options', () => {
    const { server, join } = setup(); const a = join('Host'), b = join('Guest');
    b.command('option', { key: 'credits', value: 5000 });
    expect(server.session.gameOpts.credits).toBe(10000);
    b.command('state', { ready: true }); expect(server.session.clients[1].ready).toBe(false);
    b.command('state', { ready: true, mapDigest: 'digest' });
    b.command('player', { countryId: 1 }); expect(server.session.clients[1].countryId).toBe(-2);
    a.command('option', { key: 'credits', value: 5000 });
    expect(server.session.gameOpts.credits).toBe(5000); expect(server.session.clients[1].ready).toBe(false);
    a.command('option', { key: 'humanPlayers', value: [] }); expect(server.session.gameOpts.humanPlayers).toHaveLength(2);
    a.command('startgame'); expect(server.session.state).toBe('waiting');
    b.command('state', { ready: true, mapDigest: 'digest' }); a.command('map_ready', { digest: 'digest' });
    a.command('startgame'); expect(server.session.state).toBe('started');
    expect(a.all('startGame')[0].humanAssignments).toEqual([{ clientId: 1, slotIndex: 0, name: 'Host' }, { clientId: 2, slotIndex: 1, name: 'Guest' }]);
    a.command('option', { key: 'credits', value: 0 }); expect(server.session.gameOpts.credits).toBe(5000);
});

test('latency preseed, all-loaded gate and order echo preserve exact payloads', () => {
    const { server, join } = setup(); const a = join('Host'), b = join('Guest');
    a.command('map_ready', { digest: 'digest' }); b.command('state', { ready: true, mapDigest: 'digest' }); a.command('startgame');
    expect(a.packets().map(p => p.frame)).toEqual([1, 1, 2, 2]);
    a.json({ type: 'loaded', percent: 100 }); expect(a.all('allLoaded')).toHaveLength(0);
    b.json({ type: 'loaded', percent: 100 }); expect(a.all('allLoaded')).toHaveLength(1);
    a.receive(encodeOrderPacket(1, 1, new Uint8Array([10, 20, 30])));
    expect(a.packets().at(-1)).toEqual({ kind: 'orders', generation: 1, clientId: 1, frame: 3, actions: new Uint8Array([10, 20, 30]) });
    expect(b.packets().at(-1)).toEqual(a.packets().at(-1));
    expect(server.session.state).toBe('started');
});

test('frame impersonation and future frames disconnect offender at identical future frame', () => {
    const { start } = setup(); const { a, b } = start();
    b.receive(encodeOrderPacket(2, 1, new Uint8Array()));
    b.receive(encodeOrderPacket(1, 2, new Uint8Array()));
    expect(b.closed).toBe('invalidPacket');
    expect(a.all('disconnect')).toEqual([{ type: 'disconnect', generation: 1, clientId: 2, frame: 4 }]);
});

test('sync mismatch including defeat mask ends relay for every client', () => {
    const { server, start } = setup(); const { a, b } = start();
    a.receive(encodeSyncPacket(1, 123, 0n)); b.receive(encodeSyncPacket(1, 123, 1n));
    expect(server.session.state).toBe('waiting');
    expect(a.all('outOfSync')).toEqual([{ type: 'outOfSync', generation: 1, frame: 1 }]);
    expect(b.all('outOfSync')).toEqual(a.all('outOfSync'));
    const packets = a.packets().length;
    b.receive(encodeOrderPacket(2, 1, new Uint8Array())); expect(a.packets()).toHaveLength(packets);
});

test('timeouts warn, ping, drop and transfer lobby administration', () => {
    const { server, join, advance } = setup(); const a = join('Host'), b = join('Guest');
    advance(5000); expect(a.all('ping')).toHaveLength(1);
    advance(5000); expect(b.all('message').some(m => m.key === 'connectionProblems')).toBe(true);
    b.json({ type: 'ping', t: 11000 }); advance(49000);
    b.json({ type: 'ping', t: 60000 }); advance(CONNECTION_TIMEOUT_MS - 59000);
    expect(a.closed).toBe('timeout'); expect(b.closed).toBeUndefined();
    expect(server.session.clients[0].admin).toBe(true);
});

test('pending handshakes and oversized or malformed packets are bounded', () => {
    const { server, advance, join } = setup(); const pending = new Connection(); server.accept(pending); advance(HANDSHAKE_TIMEOUT_MS);
    expect(pending.closed).toBe('timeout');
    const a = join('a'); a.receive(new Uint8Array(128 * 1024 + 1)); expect(a.closed).toBe('packetTooLarge');
    const b = join('b'); b.receive('{'); expect(b.closed).toBe('invalidPacket');
});

test('embedded host departure closes room; dedicated room remains joinable', () => {
    const { server, join } = setup({ dedicated: false }); const a = join('Host'), b = join('Guest');
    a.close('left'); expect(server.session.state).toBe('ended'); expect(b.closed).toBe('Server closed');
});

test('protocol binary decode respects offsets and rejects truncated sync packets', () => {
    const original = encodeSyncPacket(10, 0xffffffff, 0xffffffffffffffffn);
    const padded = new Uint8Array(30); padded.set(original, 4);
    expect(decodePacket(padded.subarray(4, 25))).toEqual({ kind: 'sync', generation: 1, frame: 10, hash: 0xffffffff, defeatMask: 0xffffffffffffffffn });
    expect(() => decodePacket(original.subarray(0, 16))).toThrow();
});

test('invalid slot edit is atomic and sparse AI entries preserve slot indices', () => {
    const { server, join } = setup(); const a = join('Host'), b = join('Guest');
    const before = server.session;
    b.command('player', { slotIndex: 2, countryId: 500 });
    expect(server.session).toEqual(before);
    a.command('slot_bot', { slotIndex: 3, difficulty: 4 });
    a.command('player', { slotIndex: 3, teamId: 1, countryId: 2 });
    expect(server.session.gameOpts.aiPlayers[3]).toEqual({ difficulty: 4, countryId: 2, colorId: -2, startPos: -2, teamId: 1 });
    expect(server.session.gameOpts.aiPlayers[0]).toBeNull();
    b.command('player', { slotIndex: 2, countryId: 1 });
    expect(server.session.clients[1].slotIndex).toBe(2);
    expect(server.session.slots[1].type).toBe(1);
});

test('embedded physical host retains lifecycle ownership after admin transfer and start', () => {
    const { server, join } = setup({ dedicated: false }); const a = join('Host'), b = join('Guest');
    a.command('make_admin', { clientId: 2 });
    a.command('state', { ready: true, mapDigest: 'digest' }); b.command('map_ready', { digest: 'digest' });
    b.command('startgame'); expect(server.session.state).toBe('started');
    a.close('left'); expect(server.session.state).toBe('ended'); expect(b.closed).toBe('Server closed');
});

test('spectators are enabled while multi-tick network frames remain unsupported', () => {
    const { server, join } = setup({ allowSpectators: true }); const host = join('Host');
    host.command('allow_spectators', { allow: true }); expect(server.session.allowSpectators).toBe(true);
    expect(() => setup({ netFrameInterval: 2 })).toThrow('Invalid network timing');
});

test('sync hash windows remain valid across a deterministic guest drop', () => {
    const { server, start } = setup(); const { a, b } = start();
    a.receive(encodeSyncPacket(1, 10)); b.receive(encodeSyncPacket(1, 10));
    b.close('cable pulled');
    expect(a.all('disconnect')[0]).toEqual({ type: 'disconnect', generation: 1, clientId: 2, frame: 3 });
    a.receive(encodeSyncPacket(2, 20));
    expect(server.session.state).toBe('started'); expect(a.closed).toBeUndefined();
});

test('player settings reject invalid sentinels and out-of-range engine selections atomically', () => {
    const { server, join } = setup(); const a = join('Host');
    for (const [key, value] of [['countryId', -1], ['countryId', 9], ['colorId', -1], ['colorId', 8], ['startPos', -1], ['startPos', 4], ['teamId', -1], ['teamId', 4]] as const) {
        const before = server.session; a.command('player', { slotIndex: 2, [key]: value });
        expect(server.session).toEqual(before); expect(a.closed).toBeUndefined();
    }
    a.command('player', { countryId: 8, colorId: 7, teamId: 3, startPos: 3 });
    expect(server.session.clients[0]).toMatchObject({ countryId: 8, colorId: 7, teamId: 3, startPos: 3 });
    a.command('player', { countryId: -2, colorId: -2, teamId: -2, startPos: -2 });
    expect(server.session.clients[0]).toMatchObject({ countryId: -2, colorId: -2, teamId: -2, startPos: -2 });
});

test('slowest menu speed is valid while fractional or out-of-range settings are refused', () => {
    const { server, join } = setup(); const a = join('Host');
    a.command('option', { key: 'gameSpeed', value: 0 }); expect(server.session.gameOpts.gameSpeed).toBe(0);
    for (const value of [-1, 0.5, 7, '6']) { a.command('option', { key: 'gameSpeed', value }); expect(server.session.gameOpts.gameSpeed).toBe(0); }
    expect(() => setup({ gameOpts: { ...gameOpts, gameSpeed: 7 } })).toThrow('Invalid game speed');
});

test('malformed identities and duplicate normalized names do not acquire player slots', () => {
    const { server, join } = setup(); join('Host');
    for (const name of [' host ', '', 'bad\nname', 'x'.repeat(33), null, 5]) {
        const peer = join(name as string);
        expect(peer.all('error')[0].code).toBe('invalidName'); expect(server.session.clients).toHaveLength(1);
    }
    const guest = join('Guest', { preferredCountry: -1, preferredColor: 50 });
    expect(guest.all('welcome')[0].session.clients[1]).toMatchObject({ countryId: -2, colorId: -2 });
});

test('stopped server reports lifecycle state and rejects new sockets', () => {
    const { server, join } = setup({ dedicated: false }); const a = join('Host');
    expect(server.isStopped).toBe(false); a.close('left'); expect(server.isStopped).toBe(true);
    const late = new Connection(); server.accept(late); expect(late.closed).toBe('Server unavailable');
});

test('sync reports cannot skip frames and accumulate never-completing comparison windows', () => {
    const { start } = setup(); const { a, b } = start();
    b.receive(encodeSyncPacket(2, 10)); expect(b.closed).toBe('invalidPacket');
    expect(a.all('disconnect')[0].frame).toBe(3);
});

test('in-flight binary traffic after desync preserves the original report and host connection', () => {
    const { server, start } = setup({ dedicated: false }); const { a, b } = start();
    a.receive(encodeSyncPacket(1, 123)); b.receive(encodeSyncPacket(1, 456));
    a.receive(encodeOrderPacket(1, 1, new Uint8Array())); b.receive(encodeSyncPacket(2, 789));
    expect(server.session.state).toBe('waiting'); expect(server.isStopped).toBe(false);
    expect(a.closed).toBeUndefined(); expect(b.closed).toBeUndefined();
    expect(a.all('error')).toEqual([]); expect(b.all('error')).toEqual([]);
    expect(a.all('outOfSync')).toEqual([{ type: 'outOfSync', generation: 1, frame: 1 }]);
    expect(b.all('outOfSync')).toEqual(a.all('outOfSync'));
    expect(a.all('disconnect')).toEqual([]);
});


test('sync relay stamps the actual sender and reaches everyone before a mismatch notice', () => {
    const { start } = setup(); const { a, b } = start();
    a.receive(encodeSyncPacket(1, 123, 1n)); b.receive(encodeSyncPacket(1, 123, 2n));
    const expected = [
        { kind: 'syncRelay', generation: 1, clientId: 1, frame: 1, hash: 123, defeatMask: 1n },
        { kind: 'syncRelay', generation: 1, clientId: 2, frame: 1, hash: 123, defeatMask: 2n },
    ];
    expect(a.packets().slice(-2)).toEqual(expected); expect(b.packets().slice(-2)).toEqual(expected);
    for (const peer of [a, b]) {
        const mismatch = peer.messages.findIndex(m => typeof m === 'string' && JSON.parse(m).type === 'outOfSync');
        expect(decodePacket(peer.messages[mismatch - 1] as Uint8Array)).toEqual(expected[1]);
        expect(peer.all('outOfSync')).toEqual([{ type: 'outOfSync', generation: 1, frame: 1 }]);
    }
});

test('clients cannot impersonate a relayed sync sender', () => {
    const { start } = setup(); const { a, b } = start();
    b.receive(encodeRelayedSyncPacket(1, 1, 99));
    expect(b.closed).toBe('invalidPacket');
    expect(a.packets().filter(packet => packet.kind === 'syncRelay')).toEqual([]);
});

test('relayed sync decoding respects offsets and requires the exact payload size', () => {
    const original = encodeRelayedSyncPacket(42, 10, 0xffffffff, 0xffffffffffffffffn);
    const padded = new Uint8Array(30); padded.set(original, 4);
    expect(decodePacket(padded.subarray(4, 29))).toEqual({ kind: 'syncRelay', generation: 1, clientId: 42, frame: 10, hash: 0xffffffff, defeatMask: 0xffffffffffffffffn });
    expect(() => decodePacket(original.subarray(0, 20))).toThrow();
    expect(() => decodePacket(padded.subarray(4, 30))).toThrow();
});

import { createContentManifest, encodeContentBytes, decodeContentBytes, CONTENT_CHUNK_BYTES } from '../content/ContentPackage';
let requestId=0;
async function content(connection:Connection,args:Record<string,unknown>) {
    const id=++requestId;
    connection.json({type:'content',requestId:id,...args});
    for(let i=0;i<30;i++) { await new Promise(resolve=>setTimeout(resolve,0)); const reply=connection.all('contentResult').find(m=>m.requestId===id); if(reply) return reply; }
    throw new Error('No content response');
}
test('host content transfers exact chunks and requires every content acknowledgement before start',async()=>{
    const {server,join}=setup();const a=join('Host'),b=join('Guest');
    const bytes=new Uint8Array(CONTENT_CHUNK_BYTES+17).fill(42);
    const manifest=await createContentManifest([{path:'custom.map',bytes}]);
    expect((await content(b,{action:'begin',manifest})).error).toContain('Only the host');
    expect((await content(a,{action:'begin',manifest})).error).toBeUndefined();
    a.command('map_ready',{digest:'digest'});b.command('state',{ready:true,mapDigest:'digest'});a.command('startgame');
    expect(server.session.state).toBe('waiting');
    expect((await content(a,{action:'commit',id:manifest.id})).error).toContain('incomplete');
    for(let offset=0;offset<bytes.length;offset+=CONTENT_CHUNK_BYTES) expect((await content(a,{action:'put',id:manifest.id,path:'custom.map',offset,data:encodeContentBytes(bytes.subarray(offset,offset+CONTENT_CHUNK_BYTES))})).error).toBeUndefined();
    await content(a,{action:'commit',id:manifest.id});
    expect(server.session.content).toEqual(manifest);expect(server.session.clients.every(c=>!c.ready&&!c.mapReady)).toBe(true);
    const downloaded=await content(b,{action:'get',id:manifest.id,path:'custom.map',offset:CONTENT_CHUNK_BYTES});
    expect(decodeContentBytes(downloaded.data)).toEqual(bytes.subarray(CONTENT_CHUNK_BYTES));
    a.command('map_ready',{digest:'digest'});b.command('state',{ready:true,mapDigest:'digest'});
    expect(server.session.clients[1].ready).toBe(false);
    a.command('content_ready',{id:manifest.id});b.command('content_ready',{id:'stale'});a.command('startgame');expect(server.session.state).toBe('waiting');
    b.command('content_ready',{id:manifest.id});b.command('state',{ready:true});a.command('startgame');expect(server.session.state).toBe('started');
});
test('content rejects tampering, invalid offsets and stale downloads; cancel and empty package recover',async()=>{
    const {server,join}=setup();const a=join('Host');const bytes=new Uint8Array([1,2,3]);const manifest=await createContentManifest([{path:'rules.ini',bytes}]);
    await content(a,{action:'begin',manifest});
    expect((await content(a,{action:'put',id:manifest.id,path:'rules.ini',offset:1,data:encodeContentBytes(bytes)})).error).toContain('offset');
    await content(a,{action:'put',id:manifest.id,path:'rules.ini',offset:0,data:encodeContentBytes(new Uint8Array([3,2,1]))});
    expect((await content(a,{action:'commit',id:manifest.id})).error).toContain('checksum');expect(server.session.content).toBeUndefined();
    await content(a,{action:'cancel'});
    const empty=await createContentManifest([]);await content(a,{action:'begin',manifest:empty});await content(a,{action:'commit',id:empty.id});
    expect(server.session.content).toEqual(empty);
    expect((await content(a,{action:'get',id:manifest.id,path:'rules.ini',offset:0})).error).toContain('changed');
});

test('cancelling an in-flight manifest validation does not leave the host upload locked',async()=>{
    const {server,join}=setup();const host=join('Host');const manifest=await createContentManifest([{path:'cancel.map',bytes:new Uint8Array([1])}]);
    const pending=++requestId;host.json({type:'content',requestId:pending,action:'begin',manifest});
    const cancelled=await content(host,{action:'cancel'});expect(cancelled.error).toBeUndefined();expect(host.closed).toBeUndefined();
    expect(host.all('contentResult').find(m=>m.requestId===pending)?.error).toContain('cancelled');
    expect((await content(host,{action:'begin',manifest})).error).toBeUndefined();
    await content(host,{action:'cancel'});expect(server.session.content).toBeUndefined();
});
test('upload expires and uploader departure releases pending package without publication',async()=>{
    const {server,join,advance}=setup();const host=join('Host'),guest=join('Guest');const manifest=await createContentManifest([{path:'expire.ini',bytes:new Uint8Array([1])}]);
    await content(host,{action:'begin',manifest});advance(50000);host.json({type:'ping',t:1});guest.json({type:'ping',t:1});advance(10001);
    expect((await content(host,{action:'commit',id:manifest.id})).error).toContain('expired');
    await content(host,{action:'begin',manifest});host.close('left');
    expect(server.session.content).toBeUndefined();expect(server.session.clients[0].admin).toBe(true);
    expect((await content(guest,{action:'begin',manifest})).error).toBeUndefined();
});


test('delayed heartbeat replies survive newer probes and publish measured RTT', () => {
    const {server,join,advance}=setup(); const host=join('Host'),guest=join('Guest');
    advance(5000); const first=guest.all('ping').at(-1).t;
    advance(5000); const second=guest.all('ping').at(-1).t;
    advance(7000); guest.json({type:'pong',t:first});
    expect(guest.closed).toBeUndefined();
    expect(server.session.clients.find(c=>c.name==='Guest')!.ping).toBe(12000);
    advance(1000);
    const health=host.all('connectionHealth').at(-1);
    expect(health.players.find((p:any)=>p.clientId===2)).toEqual({clientId:2,ping:12000,idleMs:1000});
    guest.json({type:'pong',t:second});
    expect(guest.closed).toBeUndefined();
    expect(server.session.clients.find(c=>c.name==='Guest')!.ping).toBe(8000);
});

test('long lobby stalls warn, retain the slot and recover on an outstanding heartbeat', () => {
    const {server,join,advance}=setup(); const guest=join('Guest');
    advance(5000); const first=guest.all('ping').at(-1).t;
    advance(65000);
    expect(guest.closed).toBeUndefined();
    const health=guest.all('connectionHealth').at(-1);
    expect(health.timeoutMs).toBe(CONNECTION_TIMEOUT_MS);
    expect(health.players[0]).toEqual({clientId:1,ping:null,idleMs:70000});
    guest.json({type:'pong',t:first});advance(1000);
    expect(server.session.clients).toHaveLength(1);
    expect(guest.all('connectionHealth').at(-1).players[0].idleMs).toBe(1000);
    expect(guest.all('error')).toEqual([]);
});

test('duplicate or unsent stale pongs cannot keep a dead peer alive', () => {
    const {join,advance}=setup();const guest=join('Guest');
    advance(5000);const t=guest.all('ping').at(-1).t;guest.json({type:'pong',t});
    advance(CONNECTION_TIMEOUT_MS-1);guest.json({type:'pong',t});guest.json({type:'pong',t:t-1});
    expect(guest.closed).toBeUndefined();
    advance(1);expect(guest.closed).toBe('timeout');
});

test('invalid heartbeat rejection includes an actionable reason', () => {
    const {join}=setup();const guest=join('Guest');
    guest.json({type:'pong',t:Infinity});
    expect(guest.closed).toBe('invalidPacket');
    expect(guest.all('error').at(-1).message).toBe('Invalid heartbeat reply');
});

test('an overlapping content request returns an error without kicking the player', async () => {
    const {join}=setup();const host=join('Host');
    host.json({type:'content',requestId:1,action:'begin',manifest:await createContentManifest([])});
    host.json({type:'content',requestId:2,action:'get',id:'pending',path:'map.map',offset:0});
    expect(host.closed).toBeUndefined();
    expect(host.all('contentResult').find((m:any)=>m.requestId===2).error).toMatch(/still in progress/);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(host.all('contentResult').some((m:any)=>m.requestId===1&&!m.error)).toBe(true);
});


test('solo host starts, loads and receives orders without waiting for another client', () => {
    const { server, join } = setup();
    const host = join('Host');
    host.command('startgame');
    expect(server.session.state).toBe('waiting'); // Map still missing.
    host.command('state', { ready: true, mapDigest: 'digest' });
    host.command('startgame');
    expect(server.session.state).toBe('started');
    expect(host.all('startGame')[0].humanAssignments).toHaveLength(1);
    expect(host.all('startGame')[0].clientIds).toEqual([1]);
    host.json({ type: 'loaded', percent: 100 });
    expect(host.all('allLoaded')).toHaveLength(1);
    host.receive(encodeOrderPacket(1, 1, new Uint8Array([10])));
    expect(host.packets().at(-1)).toEqual({ kind: 'orders', generation: 1, clientId: 1, frame: 3, actions: new Uint8Array([10]) });
});

test('solo host can start against bots while an unready guest still blocks start', () => {
    const { server, join } = setup();
    const host = join('Host');
    host.command('slot_bot', { slotIndex: 1, difficulty: 0 });
    const guest = join('Guest');
    host.command('state', { ready: true, mapDigest: 'digest' });
    guest.command('map_ready', { digest: 'digest' });
    host.command('startgame');
    expect(server.session.state).toBe('waiting');
    guest.close('Leaving');
    host.command('state', { ready: true, mapDigest: 'digest' });
    host.command('startgame');
    expect(server.session.state).toBe('started');
    expect(host.all('startGame')[0].gameOpts.aiPlayers.filter(Boolean)).toHaveLength(1);
});

test('servers may explicitly retain a two-human minimum', () => {
    const { server, join } = setup({ allowSinglePlayer: false });
    const host = join('Host');
    host.command('state', { ready: true, mapDigest: 'digest' });
    host.command('startgame');
    expect(server.session.state).toBe('waiting');
});

test('only the host receives stall attribution and can kick a player into AI', () => {
    const { start, advance } = setup(); const { a, b } = start();
    a.receive(encodeOrderPacket(1, 1, new Uint8Array()));
    advance(3000);
    expect(a.all('matchHealth').at(-1).players.find((p: any) => p.clientId === 2).lagMs).toBe(3000);
    expect(b.all('matchHealth')).toHaveLength(0);
    b.command('kick_ai', { clientId: 1 });
    expect(a.closed).toBeUndefined();
    a.command('kick_ai', { clientId: 1 });
    expect(a.closed).toBeUndefined();
    a.command('kick_ai', { clientId: 2 });
    expect(b.closed).toBe('kicked');
    expect(a.all('disconnect').at(-1)).toEqual({ type: 'disconnect', generation: 1, clientId: 2, frame: 3, takeover: 'ai' });
});

for (const disconnectAi of [false, true]) test(`disconnect policy is server controlled: AI=${disconnectAi}`, () => {
    const { server, join } = setup(); const host = join('Host'), guest = join('Guest');
    guest.command('option', { key: 'disconnectAi', value: !disconnectAi });
    expect(server.session.gameOpts.disconnectAi).toBeUndefined();
    host.command('option', { key: 'disconnectAi', value: disconnectAi });
    host.command('map_ready', { digest: 'digest' }); guest.command('state', { ready: true, mapDigest: 'digest' });
    host.command('startgame');
    expect(host.all('startGame')[0].gameOpts.disconnectAi).toBe(disconnectAi);
    host.command('option', { key: 'disconnectAi', value: !disconnectAi });
    expect(server.session.gameOpts.disconnectAi).toBe(disconnectAi);
    guest.close('Quit');
    expect(host.all('disconnect').at(-1).takeover).toBe(disconnectAi ? 'ai' : undefined);
});

test('player orders cannot inject server-only takeover or destruction actions', () => {
    for (const actionId of [14, 15]) {
        const {start} = setup(); const {a,b} = start();
        b.receive(encodeOrderPacket(2,1,new Uint8Array([1,actionId,0,0])));
        expect(b.closed).toBe('invalidPacket');
        expect(a.packets().some(packet => packet.kind === 'orders' && packet.actions[1] === actionId)).toBe(false);
    }
});


test('embedded host returns without closing room, remaining commander progresses and both play a second round', () => {
    const { server, start } = setup({ dedicated: false }); const { a, b } = start();
    const original = server.session;
    a.json({ type: 'returnToLobby', reason: 'forfeit' });
    expect(server.session.state).toBe('started'); expect(server.isStopped).toBe(false);
    expect(a.closed).toBeUndefined(); expect(b.closed).toBeUndefined();
    expect(b.all('disconnect').at(-1)).toEqual({ type: 'disconnect', generation: 1, clientId: 1, frame: 3 });
    // The waiting host is excluded from both bounded sequence minima.
    for (let frame = 1; frame <= 300; frame++) {
        b.receive(encodeOrderPacket(2, frame, new Uint8Array()));
        b.receive(encodeSyncPacket(frame, frame));
    }
    expect(b.closed).toBeUndefined();
    a.command('kick_ai', { clientId: 2, generation: 0 }); expect(b.closed).toBeUndefined();
    b.json({ type: 'returnToLobby', reason: 'finished' });
    expect(server.session.state).toBe('waiting');
    expect(server.session.slots).toEqual(original.slots);
    expect(server.session.gameOpts).toEqual(original.gameOpts);
    expect(server.session.clients.every(c => !c.ready && c.loaded === 0)).toBe(true);
    b.command('state', { ready: true }); a.command('startgame');
    expect(server.session.generation).toBe(2);
    expect(a.all('startGame')).toHaveLength(2);
    a.json({ type: 'loaded', percent: 100 }); b.json({ type: 'loaded', percent: 100 });
    a.receive(encodeOrderPacket(1, 1, new Uint8Array(), 2));
    b.receive(encodeOrderPacket(2, 1, new Uint8Array(), 2));
    expect(b.packets().at(-1)).toMatchObject({ generation: 2, frame: 3, clientId: 2 });
    expect(a.closed).toBeUndefined(); expect(b.closed).toBeUndefined();
});

test('one completion claim releases only its sender and stale traffic cannot enter the next match', () => {
    const { server, start } = setup(); const { a, b } = start();
    const first = a.all('startGame')[0];
    a.json({ type: 'returnToLobby', reason: 'finished' });
    expect(server.session.state).toBe('started'); expect(a.all('matchEnded')).toHaveLength(0);
    // Duplicate reports and commands from the returned member have no authority.
    a.json({ type: 'returnToLobby', reason: 'finished' });
    a.receive(encodeSyncPacket(1, 999));
    b.receive(encodeSyncPacket(1, 10));
    expect(server.session.state).toBe('started');
    b.json({ type: 'returnToLobby', reason: 'finished' });
    expect(a.all('matchEnded').at(-1).reason).toBe('finished');
    a.receive(encodeOrderPacket(1, 1, new Uint8Array()));
    b.command('state', { ready: true }); a.command('startgame');
    a.json({ type: 'loaded', gameId: first.gameId, generation: 1, percent: 100 });
    expect(server.session.clients[0].loaded).toBe(0);
    a.json({ type: 'returnToLobby', gameId: first.gameId, generation: 1, reason: 'finished' });
    a.receive(encodeOrderPacket(1, 1, new Uint8Array()));
    expect(server.session.state).toBe('started'); expect(a.closed).toBeUndefined();
    a.json({ type: 'loaded', percent: 100 }); b.json({ type: 'loaded', percent: 100 });
    a.receive(encodeOrderPacket(1, 1, new Uint8Array(), 2));
    expect(a.packets().at(-1)).toMatchObject({ generation: 2, frame: 3 });
});

test('return during loading releases the loading barrier while physical departure frees the reserved slot', () => {
    const { server, join } = setup(); const a = join('Host'), b = join('Guest');
    a.command('map_ready', { digest: 'digest' }); b.command('state', { ready: true, mapDigest: 'digest' }); a.command('startgame');
    a.json({ type: 'loaded', percent: 100 });
    b.json({ type: 'returnToLobby', reason: 'forfeit' });
    expect(a.all('allLoaded')).toHaveLength(1);
    expect(server.session.slots[1].type).toBe(3);
    b.close('Leave server');
    expect(server.session.slots[1].type).toBe(1);
    expect(a.all('disconnect')).toHaveLength(1);
    a.json({ type: 'returnToLobby', reason: 'forfeit' });
    expect(server.session.state).toBe('waiting');
    expect(join('Replacement').closed).toBeUndefined();
});

test('observer roles release seats and exclude readiness, load and packet barriers', () => {
    const { server, join } = setup(); const a = join('Host'), o = join('Observer', { role: 'observer' });
    expect(server.session.clients[1].slotIndex).toBeNull();
    a.command('map_ready', { digest: 'digest' }); a.command('startgame');
    expect(a.all('startGame')).toHaveLength(1); expect(o.all('startGame')).toHaveLength(0);
    a.json({ type: 'loaded', percent: 100 }); expect(a.all('allLoaded')).toHaveLength(1);
    o.receive(encodeOrderPacket(2,1,new Uint8Array([9]))); o.receive(encodeSyncPacket(1,999));
    expect(a.packets().some(p => p.kind === 'orders' && p.clientId === 2)).toBe(false);
    expect(o.packets()).toHaveLength(0); expect(server.session.state).toBe('started');
    o.command('map_ready', { digest:'digest' }); o.command('observe');
    expect(o.all('startGame')[0].observer).toBe(true);
});

test('observer chat stamps identity and blocks cross-role whispers and forged team access', () => {
    const { join } = setup(); const a=join('Host'), b=join('Ally'), o=join('Observer',{role:'observer'}), p=join('Other Observer',{role:'observer'});
    a.command('player',{teamId:1}); b.command('player',{teamId:1});
    o.json({type:'chat',to:'all',text:'leak'}); o.json({type:'chat',to:1,text:'leak'}); o.json({type:'chat',to:'team',text:'leak'});
    expect(a.all('chat')).toHaveLength(0);
    o.json({type:'chat',to:'observers',text:'hello',sender:{name:'Host'}});
    expect(p.all('chat')[0].sender.name).toBe('Observer'); expect(a.all('chat')).toHaveLength(0);
    a.json({type:'chat',to:'team',text:'attack'});
    expect(o.all('chat').at(-1).text).toBe('attack'); expect(b.all('chat')).toHaveLength(1);
    a.json({type:'chat',to:2,text:'private'}); expect(o.all('chat')).toHaveLength(2);
});

test('running joins authenticate into waiting without seats or team/history access', () => {
    const { server, start, join }=setup(); const {a}=start(); const w=join('Waiting');
    expect(server.session.clients.at(-1)?.role).toBe('waiting'); expect(server.session.clients.at(-1)?.slotIndex).toBeNull();
    a.json({type:'chat',to:'team',text:'secret'}); expect(w.all('chat')).toHaveLength(0); expect(w.packets()).toHaveLength(0);
    w.json({type:'chat',to:'observers',text:'bad'}); expect(w.all('error').at(-1).code).toBe('invalidCommand');
    w.command('map_ready',{digest:'digest'}); w.command('observe'); expect(w.all('startGame')[0].observer).toBe(true);
});

test('late observers pull only agreed contiguous history and retries isolate observation attempts', () => {
    const {start,join,server}=setup(); const {a,b}=start();
    const o=join('Observer',{role:'observer'}); o.command('map_ready',{digest:'digest'}); o.command('observe');
    const first=o.all('startGame')[0];
    o.command('observe'); expect(o.all('startGame')).toHaveLength(1);
    const pull=(fromFrame:number, observationId=first.observationId)=>o.json({type:'history',gameId:first.gameId,generation:first.generation,observationId,fromFrame});
    a.receive(encodeSyncPacket(1,10)); pull(1); expect(o.all('history').at(-1).frames).toHaveLength(0);
    b.receive(encodeSyncPacket(1,10)); pull(1); expect(o.all('history').at(-1).frames[0]).toEqual({frame:1,orders:[{clientId:1,actions:''},{clientId:2,actions:''}],drops:[],hash:10,defeatMask:'0'});
    expect(o.packets()).toHaveLength(0);
    o.json({type:'returnToLobby',gameId:first.gameId,generation:first.generation,observationId:first.observationId,reason:'finished'});
    o.command('observe'); const second=o.all('startGame').at(-1); expect(second.observationId).toBeGreaterThan(first.observationId);
    const count=o.all('history').length; pull(2); expect(o.all('history')).toHaveLength(count);
    pull(1,second.observationId); expect(o.all('history').at(-1).frames).toHaveLength(1);
    expect(server.session.state).toBe('started');
});

test('history exhaustion refuses observation without interrupting combatants', () => {
    const {start,join,server}=setup({observerArchiveMaxBytes:1});const {a,b}=start();const o=join('Observer',{role:'observer'});
    o.command('map_ready',{digest:'digest'});o.command('observe');expect(o.all('error').at(-1).code).toBe('observerUnavailable');
    a.receive(encodeSyncPacket(1,10));b.receive(encodeSyncPacket(1,10));expect(server.session.state).toBe('started');expect(a.closed).toBeUndefined();
});

test('observer role restores a free seat, cannot claim occupied seats or kick active commanders', () => {
 const {server,join}=setup();const a=join('Host'),b=join('Guest');b.command('role',{role:'observer'});expect(server.session.slots[1].type).toBe(1);
 b.command('role',{role:'player'});expect(server.session.clients[1].role).toBe('player');expect(server.session.clients[1].slotIndex).toBe(1);
 a.command('role',{role:'observer'});a.command('player',{slotIndex:1});expect(server.session.clients[0].role).toBe('observer');
 b.command('map_ready',{digest:'digest'});b.command('state',{ready:true,mapDigest:'digest'});a.command('startgame');b.json({type:'loaded',percent:100});
 const match=b.all('startGame')[0];a.command('kick_ai',{gameId:match.gameId,generation:match.generation,clientId:2});expect(b.closed).toBeUndefined();expect(server.session.state).toBe('started');
});

test('committed catch-up retains departed commander orders and scheduled AI drop', () => {
 const {start,join}=setup({gameOpts:{...gameOpts,disconnectAi:true}});const {a,b}=start();
 a.receive(encodeOrderPacket(1,1,new Uint8Array()));b.receive(encodeOrderPacket(2,1,new Uint8Array()));b.close('left');
 for(let frame=1;frame<=3;frame++)a.receive(encodeSyncPacket(frame,frame*10));
 a.receive(encodeOrderPacket(1,2,new Uint8Array()));a.receive(encodeSyncPacket(4,40));
 const o=join('Observer',{role:'observer'});o.command('map_ready',{digest:'digest'});o.command('observe');const startMessage=o.all('startGame')[0];
 o.json({type:'history',gameId:startMessage.gameId,generation:1,observationId:startMessage.observationId,fromFrame:1});
 const frames=o.all('history')[0].frames;expect(frames[2].orders.map((p:any)=>p.clientId)).toEqual([1,2]);expect(frames[3].drops).toEqual([{clientId:2,frame:4,takeover:'ai'}]);
});

test('a stale observe command cannot promote a waiter or subscribe them to a later round', () => {
    const { server, start, join } = setup(); const { a, b } = start(); const waiting = join('Next round');
    const first = a.all('startGame')[0];
    waiting.command('map_ready', { digest: 'digest' });
    a.json({ type: 'returnToLobby', reason: 'finished' }); b.json({ type: 'returnToLobby', reason: 'finished' });
    b.command('state', { ready: true, mapDigest: 'digest' }); a.command('startgame');
    const second = a.all('startGame').at(-1); expect(second.generation).toBe(first.generation + 1);
    waiting.command('observe', { gameId: first.gameId, generation: first.generation });
    expect(waiting.all('startGame')).toHaveLength(0);
    expect(server.session.clients.find(client => client.name === 'Next round')?.role).toBe('waiting');
    waiting.command('observe'); expect(waiting.all('startGame')[0].generation).toBe(second.generation);
    expect(server.session.clients.find(client => client.name === 'Next round')?.role).toBe('observer');
});
