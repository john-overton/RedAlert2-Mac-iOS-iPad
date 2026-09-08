import { expect, test } from 'bun:test';
import { LobbyClient } from './LobbyClient';
import { WebSocketConnection } from './WebSocketConnection';
import type { HelloMessage } from '@/network/server/Protocol';

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
const hello: HelloMessage = { type: 'hello', protocol: 1, ordersProtocol: 2, name: 'Alice', engine: 'ra2', version: 'test', mod: 'ra2', modHash: 'rules', assetFingerprint: 'retail' };

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
