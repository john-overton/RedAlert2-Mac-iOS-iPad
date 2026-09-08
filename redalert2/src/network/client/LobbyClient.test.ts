import { expect, test } from 'bun:test';
import { LobbyClient } from './LobbyClient';
import { WebSocketConnection } from './WebSocketConnection';
import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL, type HelloMessage } from '@/network/server/Protocol';

class FakeSocket {
    readyState = 0;
    binaryType = '';
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { reason: string }) => void;
    sent: string[] = [];
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.({ reason: 'closed' }); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const hello: HelloMessage = { type: 'hello', protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, name: 'Alice', engine: 'ra2', version: 'test', mod: 'ra2', modHash: 'rules', assetFingerprint: 'retail' };

test('password rejection is specific and the same lobby client can retry', async () => {
    const sockets: FakeSocket[] = [];
    const connection = new WebSocketConnection(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as any; });
    const lobby = new LobbyClient(connection);
    const connecting = lobby.connect('host', hello);
    sockets[0].open(); await Promise.resolve();
    sockets[0].receive({ type: 'error', code: 'passwordWrong' });
    await expect(connecting).rejects.toMatchObject({ code: 'passwordWrong', message: 'The password is incorrect.' });
    expect(sockets[0].readyState).toBe(3);
    const retry = lobby.connect('host', { ...hello, password: 'correct' });
    sockets[1].open(); await Promise.resolve();
    sockets[1].receive({ type: 'welcome', clientId: 2, session: { state: 'waiting', clients: [] } });
    await retry;
    expect(lobby.clientId).toBe(2);
    expect(JSON.parse(sockets[1].sent[0]).password).toBe('correct');
    sockets[1].receive({ type: 'ping', t: 123 });
    expect(JSON.parse(sockets[1].sent[1])).toEqual({ type: 'pong', t: 123 });
    lobby.close();
});

test('failed socket connections can retry and explicit cancellation settles connect', async () => {
    const sockets: FakeSocket[] = [];
    const connection = new WebSocketConnection(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as any; });
    const first = connection.connect('host'); sockets[0].onerror?.();
    await expect(first).rejects.toThrow('Could not connect');
    const second = connection.connect('host'); connection.close();
    await expect(second).rejects.toThrow('Connection cancelled');
});

test('events queued on a cancelled socket cannot mutate or close its replacement', async () => {
    const sockets: FakeSocket[] = [];
    const connection = new WebSocketConnection(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as any; });
    const received: unknown[] = [];
    connection.onMessage.subscribe(message => received.push(message));
    const first = connection.connect('host');
    connection.close();
    await expect(first).rejects.toThrow('cancelled');
    const second = connection.connect('host');
    sockets[0].onerror?.();
    sockets[0].open();
    sockets[0].receive({ type: 'session', session: 'stale' });
    sockets[1].open();
    await second;
    connection.sendImmediate({ type: 'ping', t: 1 });
    expect(sockets[1].sent).toHaveLength(1);
    expect(received).toEqual([]);
    connection.close();
});

import { GameServer } from '../server/GameServer';
import { createContentManifest, CONTENT_CHUNK_BYTES, encodeContentBytes } from '../content/ContentPackage';
import type { ServerConnection, WireData } from '../server/ServerTransport';
class LinkedSocket extends FakeSocket implements ServerConnection {
    remoteAddress='127.0.0.1';
    incoming:(data:WireData)=>void=()=>{};
    closing:()=>void=()=>{};
    // Server uses this separate adapter; socket.send is the client -> server direction.
    adapter:ServerConnection={remoteAddress:this.remoteAddress,send:data=>queueMicrotask(()=>this.receive(JSON.parse(data as string))),close:()=>this.close(),onMessage:handler=>{this.incoming=handler;},onClose:handler=>{this.closing=handler;}};
    send(data:string) { super.send(data); queueMicrotask(()=>this.incoming(data)); }
    onMessage(handler:(data:WireData)=>void) {this.incoming=handler;}
    onClose(handler:()=>void) {this.closing=handler;}
    close() {super.close();this.closing();}
}
test('real lobby client publishes, downloads, reuses verified cache, and resets package',async()=>{
    const server=new GameServer({identity:hello,gameOpts:{gameSpeed:3,maxSlots:2,mapDigest:'test',aiPlayers:[]} as any,dedicated:true});
    async function join(name:string) {
        let socket:LinkedSocket;
        const lobby=new LobbyClient(new WebSocketConnection(()=>{socket=new LinkedSocket();server.accept(socket.adapter);queueMicrotask(()=>socket.open());return socket as any;}));
        await lobby.connect('localhost',{...hello,name});return {lobby,socket:socket!};
    }
    const host=await join('Host');const guest=await join('Guest');
    const files=[{path:'custom.map',bytes:new Uint8Array(CONTENT_CHUNK_BYTES+11).fill(9)},{path:'rules.ini',bytes:new TextEncoder().encode('[MTNK]\nStrength=800')}];
    const manifest=await host.lobby.publishContent(files);expect(guest.lobby.session?.content?.id).toBe(manifest.id);
    const progress:number[]=[];expect(await guest.lobby.downloadContent(manifest,received=>progress.push(received))).toEqual(files.sort((a,b)=>a.path.localeCompare(b.path)));
    expect(progress.at(-1)).toBe(manifest.totalBytes);
    const before=guest.socket.sent.length;expect(await guest.lobby.downloadContent(manifest)).toHaveLength(2);expect(guest.socket.sent.length).toBe(before);
    const changed=await host.lobby.publishContent([files[0],{path:'rules.ini',bytes:new TextEncoder().encode('[MTNK]\nStrength=900')}]);
    const beforeChanged=guest.socket.sent.length;await guest.lobby.downloadContent(changed);
    expect(guest.socket.sent.slice(beforeChanged).map(data=>JSON.parse(data)).filter(message=>message.action==='get').map(message=>message.path)).toEqual(['rules.ini']);
    const empty=await host.lobby.publishContent([]);expect(await guest.lobby.downloadContent(empty)).toEqual([]);
    await expect(guest.lobby.downloadContent(manifest)).rejects.toThrow('changed');
    host.lobby.close();guest.lobby.close();server.stop();
});
test('download cancellation, socket close and corrupted data settle without readying',async()=>{
    const socket=new FakeSocket();const lobby=new LobbyClient(new WebSocketConnection(()=>socket as any));
    const connecting=lobby.connect('host',hello);socket.open();await Promise.resolve();
    const manifest=await createContentManifest([{path:'unique.map',bytes:new Uint8Array([5,6,7])}]);
    socket.receive({type:'welcome',clientId:1,session:{content:manifest,clients:[]}});await connecting;
    const abort=new AbortController();const pending=lobby.downloadContent(manifest,undefined,abort.signal);
    await new Promise(resolve=>setTimeout(resolve,0));abort.abort();await expect(pending).rejects.toThrow('cancelled');
    const corrupt=lobby.downloadContent(manifest);await new Promise(resolve=>setTimeout(resolve,0));
    const request=JSON.parse(socket.sent.at(-1)!);socket.receive({type:'contentResult',requestId:request.requestId,data:encodeContentBytes(new Uint8Array([0,0,0]))});
    await expect(corrupt).rejects.toThrow('checksum');
    const closing=lobby.downloadContent(manifest);await new Promise(resolve=>setTimeout(resolve,0));lobby.close();await expect(closing).rejects.toThrow('cancelled');
    expect(socket.sent.some(data=>JSON.parse(data).name==='content_ready')).toBe(false);
});


test('server rejection details survive the socket close notification', async () => {
    const socket=new FakeSocket();const lobby=new LobbyClient(new WebSocketConnection(()=>socket as any));
    const connecting=lobby.connect('host',hello);socket.open();await Promise.resolve();
    socket.receive({type:'welcome',clientId:1,session:{state:'waiting',clients:[]}});await connecting;
    const errors:any[]=[];lobby.onError.subscribe(error=>errors.push(error));
    socket.receive({type:'error',code:'invalidPacket',message:'Invalid heartbeat reply'});
    socket.close();
    expect(errors.at(-1)).toMatchObject({code:'invalidPacket',disconnected:true});
    expect(errors.at(-1).message).toContain('Invalid heartbeat reply');
    expect(errors.at(-1).message).not.toBe('closed');
    lobby.close();
});

test('ping updates have their own event and do not replace lobby options or readiness', async () => {
    const socket=new FakeSocket();const lobby=new LobbyClient(new WebSocketConnection(()=>socket as any));
    const connecting=lobby.connect('host',hello);socket.open();await Promise.resolve();
    const session={state:'waiting',clients:[{id:1,name:'Alice',ready:true,ping:0}],gameOpts:{mapDigest:'keep'}};
    socket.receive({type:'welcome',clientId:1,session});await connecting;
    const updates:any[]=[];lobby.onConnectionHealth.subscribe(value=>updates.push(value));
    let sessions=0;lobby.onSession.subscribe(()=>sessions++);
    socket.receive({type:'connectionHealth',timeoutMs:120000,players:[{clientId:1,ping:234,idleMs:0}]});
    expect(updates[0]).toMatchObject({players:[{clientId:1,ping:234,idleMs:0}],timeoutMs:120000});
    expect(lobby.session!.clients[0]).toMatchObject({ready:true,ping:234});
    expect(lobby.session!.gameOpts.mapDigest).toBe('keep');expect(sessions).toBe(0);
    lobby.close();expect(lobby.getConnectionHealth()).toBeUndefined();
});


test('match receives the original disconnect before lobby cleanup disposes it', async () => {
    const socket = new FakeSocket();
    const connection = new WebSocketConnection(() => socket as any);
    const lobby = new LobbyClient(connection);
    const connecting = lobby.connect('host', hello);
    socket.open(); await Promise.resolve();
    socket.receive({ type: 'welcome', clientId: 1, session: { state: 'waiting', clients: [{ id: 1, admin: true }] } });
    await connecting;
    socket.receive({ type: 'startGame', gameId: 'test', generation: 1, timestamp: 1, gameOpts: {}, clientIds: [1],
        humanAssignments: [{ clientId: 1, slotIndex: 0, name: 'Alice' }], orderLatency: 2, netFrameInterval: 1 });
    const match = lobby.getMatchSession();
    const errors: string[] = [];
    match.onFatalError.subscribe(error => errors.push(error.message));
    lobby.onError.subscribe(() => lobby.close());
    socket.close();
    expect(errors).toEqual(['closed']);
    expect(match.fatalError?.message).toBe('closed');
});

test('two rounds reuse a connection, with stale round traffic isolated and lobby ping retained', async () => {
    const socket = new FakeSocket();
    const lobby = new LobbyClient(new WebSocketConnection(() => socket as any));
    const connecting = lobby.connect('host', hello);
    socket.open(); await Promise.resolve();
    const waiting = { state: 'waiting', generation: 0, clients: [{ id: 1, admin: true }] };
    socket.receive({ type: 'welcome', clientId: 1, session: waiting });
    await connecting;
    const errors: string[] = [];
    lobby.onError.subscribe(error => errors.push(error.message));
    const start = (generation: number) => ({
        type: 'startGame', gameId: `round-${generation}`, generation, timestamp: 1, gameOpts: {},
        humanAssignments: [{ clientId: 1, slotIndex: 0, name: 'Alice' }], clientIds: [1], orderLatency: 2, netFrameInterval: 1,
    });
    try {
        socket.receive(start(1));
        const first = lobby.getMatchSession();
        first.returnToLobby('finished');
        expect(socket.readyState).toBe(1);
        expect(() => lobby.getMatchSession()).toThrow('not started');
        socket.receive({ type: 'matchEnded', gameId: 'round-1', generation: 1, reason: 'finished' });
        socket.receive({ type: 'session', session: { ...waiting, generation: 1 } });
        socket.receive({ type: 'ping', t: 42 });
        expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'pong', t: 42 });
        socket.receive(start(2));
        const second = lobby.getMatchSession();
        expect(second).not.toBe(first);
        socket.receive(start(1));
        socket.receive({ type: 'matchEnded', gameId: 'round-1', generation: 1, reason: 'finished' });
        socket.receive({ type: 'outOfSync', generation: 1, frame: 9 });
        socket.receive({ type: 'allLoaded', generation: 1 });
        expect(lobby.getMatchSession()).toBe(second);
        expect(second.areAllPlayersLoaded()).toBe(false);
        expect(second.fatalError).toBeUndefined();
        socket.receive({ type: 'allLoaded', generation: 2 });
        expect(second.areAllPlayersLoaded()).toBe(true);
        const before = socket.sent.length;
        first.submitLocalTurn(0, new Uint8Array());
        first.reportLoadProgress(100);
        expect(socket.sent).toHaveLength(before);
        expect(errors).toEqual([]);
    } finally { lobby.close(); }
});
