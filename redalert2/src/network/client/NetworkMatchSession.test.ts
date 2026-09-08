import { describe, expect, test } from 'bun:test';
import { EventDispatcher } from '@/util/event';
import { NetworkMatchSession } from './NetworkMatchSession';
import { parseServerAddress, WebSocketConnection } from './WebSocketConnection';
import { decodePacket, encodeOrderPacket, encodeSyncPacket, encodeRelayedSyncPacket, type StartGameMessage } from '@/network/server/Protocol';
import type { LanLaunchDescriptor } from '@/network/lan/LanRoomSession';

function fixture() {
    const outgoing: (string | Uint8Array)[] = [];
    const connection = {
        onMessage: new EventDispatcher<any, string | Uint8Array>(), onClose: new EventDispatcher<any, string>(),
        sendRaw: (data: Uint8Array) => outgoing.push(data), sendImmediate: (data: unknown) => outgoing.push(JSON.stringify(data)), close() {},
    };
    const start: StartGameMessage = {
        type: 'startGame', gameId: 'test', generation: 0, timestamp: 1, gameOpts: {} as any, clientIds: [1, 2],
        humanAssignments: [{ clientId: 1, slotIndex: 0, name: 'Alice' }, { clientId: 2, slotIndex: 1, name: 'Bob' }], orderLatency: 2, netFrameInterval: 1,
    };
    const descriptor: LanLaunchDescriptor = {
        kind: 'lan', roomId: 'test', gameId: 'test', timestamp: 1, gameOpts: {} as any,
        hostPeerId: '1', localPeerId: '1', localPlayerName: 'Alice',
        humanAssignments: start.humanAssignments.map(item => ({ peerId: String(item.clientId), slotIndex: item.slotIndex, name: item.name })),
        mapTransferStateByPeerId: {}, returnRoute: { screenType: 0 },
    };
    const match = new NetworkMatchSession(connection as unknown as WebSocketConnection, start, descriptor);
    const receive = (data: unknown) => connection.onMessage.dispatch(connection, data instanceof Uint8Array ? data : JSON.stringify({ generation: 0, ...(data as object) }));
    const frame = (id: number, frame: number, actions = new Uint8Array()) => receive(encodeOrderPacket(id, frame, actions));
    return { match, outgoing, receive, frame, connection };
}

describe('direct server addresses', () => {
    test('supports hostnames, explicit ports, IPv6, join URLs and TLS', () => {
        expect(parseServerAddress('  game.local ')).toBe('ws://game.local:1620/');
        expect(parseServerAddress('192.168.1.8:2000')).toBe('ws://192.168.1.8:2000/');
        expect(parseServerAddress('[::1]:1621')).toBe('ws://[::1]:1621/');
        expect(parseServerAddress('ra2://game.local:1620')).toBe('ws://game.local:1620/');
        expect(parseServerAddress('wss://game.example:8443')).toBe('wss://game.example:8443/');
        expect(parseServerAddress('host:80')).toBe('ws://host/');
    });
    test('rejects unrelated schemes and credentials', () => {
        for (const value of ['', 'https://game.test', 'ws://user:password@host', 'host/path', 'host?password=secret', 'host:0']) {
            expect(() => parseServerAddress(value)).toThrow();
        }
    });
});

describe('server frame buffering', () => {
    test('load gate and complete preseed frames precede delayed local actions', () => {
        const { match, outgoing, receive, frame } = fixture();
        const acknowledgements: string[] = [];
        match.onActionsReceived.subscribe(id => acknowledgements.push(id));
        match.submitLocalTurn(0, new Uint8Array([42]));
        match.submitLocalTurn(0, new Uint8Array([99]));
        expect(outgoing.length).toBe(1);
        expect(decodePacket(outgoing[0] as Uint8Array)).toEqual({ kind: 'orders', generation: 0, clientId: 1, frame: 1, actions: new Uint8Array([42]) });
        frame(1, 1); frame(2, 1); frame(1, 2); frame(2, 2);
        expect(match.tryConsumeTurn(0)).toBeUndefined();
        receive({ type: 'allLoaded' });
        expect(match.tryConsumeTurn(0)?.batches.every(batch => batch.actionData.length === 0)).toBe(true);
        expect(match.tryConsumeTurn(1)).toBeDefined();
        frame(2, 3);
        expect(match.tryConsumeTurn(2)).toBeUndefined();
        expect(acknowledgements).toEqual([]);
        frame(1, 3, new Uint8Array([42]));
        expect(match.tryConsumeTurn(2)?.batches[0].actionData).toEqual(new Uint8Array([42]));
        expect(acknowledgements).toEqual(['1:1']);
    });
    test('disconnect removes a player only on the server-assigned frame', () => {
        const { match, receive, frame } = fixture();
        receive({ type: 'allLoaded' }); receive({ type: 'disconnect', clientId: 2, frame: 2 });
        frame(1, 1); expect(match.tryConsumeTurn(0)).toBeUndefined(); frame(2, 1);
        expect(match.tryConsumeTurn(0)?.dropPeerIds).toEqual([]);
        frame(1, 2); expect(match.tryConsumeTurn(1)?.dropPeerIds).toEqual(['2']);
        frame(1, 3); expect(match.tryConsumeTurn(2)?.batches.map(batch => batch.peerId)).toEqual(['1']);
    });
    test('out of sync stops complete frames and retains the mismatch frame', () => {
        const { match, receive, frame } = fixture();
        receive({ type: 'allLoaded' }); frame(1, 1); frame(2, 1);
        receive({ type: 'outOfSync', frame: 17 });
        expect(match.fatalError?.frame).toBe(17);
        expect(match.tryConsumeTurn(0)).toBeUndefined();
    });
    test('socket loss and late disconnect are terminal instead of guessing a drop', () => {
        const { match, receive, frame } = fixture();
        receive({ type: 'allLoaded' }); frame(1, 1); frame(2, 1); match.tryConsumeTurn(0);
        receive({ type: 'disconnect', clientId: 2, frame: 1 });
        expect(match.fatalError?.message).toContain('late player disconnect');
        const second = fixture(); second.connection.onClose.dispatch(second.connection, 'Cable disconnected');
        expect(second.match.fatalError?.message).toBe('Cable disconnected');
    });
});


describe('independent client sync comparison', () => {
    test('matching local values and relays work in either arrival order over a long match', () => {
        const { match, receive, frame } = fixture();
        receive({ type: 'allLoaded' });
        for (let tick = 0; tick < 700; tick++) {
            frame(1, tick + 1); frame(2, tick + 1);
            expect(match.tryConsumeTurn(tick)).toBeDefined();
            if (tick % 2) match.sendSync(tick, -1, 1n);
            receive(encodeRelayedSyncPacket(2, tick + 1, 0xffffffff, 1n));
            receive(encodeRelayedSyncPacket(1, tick + 1, 0xffffffff, 1n));
            if (!(tick % 2)) match.sendSync(tick, -1, 1n);
        }
        expect(match.fatalError).toBeUndefined();
    });
    test('peer hash and defeat mismatches stop locally without a server notice', () => {
        for (const [hash, mask] of [[11, 0n], [10, 1n]] as const) {
            const { match, receive, frame } = fixture();
            receive({ type: 'allLoaded' }); frame(1, 1); frame(2, 1);
            match.sendSync(0, 10);
            receive(encodeRelayedSyncPacket(2, 1, hash, mask));
            expect(match.fatalError).toEqual({ message: 'Game out of sync at frame 1.', frame: 1 });
            expect(match.tryConsumeTurn(0)).toBeUndefined();
            receive({ type: 'outOfSync', frame: 20 });
            expect(match.fatalError?.frame).toBe(1);
        }
    });
    test('local computation detects changed echoes and still transmits its evidence', () => {
        const { match, receive, outgoing } = fixture();
        receive(encodeRelayedSyncPacket(1, 1, 99));
        receive(encodeRelayedSyncPacket(2, 1, 99));
        match.sendSync(0, 10);
        expect(match.fatalError?.frame).toBe(1);
        expect(decodePacket(outgoing[0] as Uint8Array)).toEqual({ kind: 'sync', generation: 0, frame: 1, hash: 10, defeatMask: 0n });
    });
    test('peer relays are compared before local simulation reaches the frame', () => {
        const { match, receive } = fixture();
        receive(encodeRelayedSyncPacket(1, 1, 10));
        receive(encodeRelayedSyncPacket(2, 1, 20));
        expect(match.fatalError?.frame).toBe(1);
    });
    test('a disconnect releases unfinished comparisons while preserving scheduled simulation drops', () => {
        const { match, receive, frame } = fixture();
        receive({ type: 'allLoaded' });
        frame(1, 1); frame(2, 1); match.tryConsumeTurn(0);
        match.sendSync(0, 10); receive(encodeRelayedSyncPacket(1, 1, 10));
        receive({ type: 'disconnect', clientId: 2, frame: 2 });
        for (let tick = 1; tick < 700; tick++) {
            frame(1, tick + 1);
            const turn = match.tryConsumeTurn(tick);
            expect(turn?.dropPeerIds).toEqual(tick === 1 ? ['2'] : []);
            match.sendSync(tick, tick); receive(encodeRelayedSyncPacket(1, tick + 1, tick));
        }
        expect(match.fatalError).toBeUndefined();
    });
    test('unknown, duplicate, skipped, unstamped and disconnected relays are rejected', () => {
        for (const input of [encodeRelayedSyncPacket(3, 1, 10), encodeRelayedSyncPacket(2, 2, 10), encodeSyncPacket(1, 10)]) {
            const { match, receive } = fixture(); receive(input); expect(match.fatalError).toBeDefined();
        }
        const duplicate = fixture();
        duplicate.receive(encodeRelayedSyncPacket(2, 1, 10)); duplicate.receive(encodeRelayedSyncPacket(2, 1, 10));
        expect(duplicate.match.fatalError?.message).toContain('invalid sync sequence');
        const dropped = fixture(); dropped.receive({ type: 'disconnect', clientId: 2, frame: 3 });
        dropped.receive(encodeRelayedSyncPacket(2, 1, 10));
        expect(dropped.match.fatalError?.message).toContain('disconnected');
    });
    test('missing reports cannot grow client comparison state without a bound', () => {
        const { match, receive, frame } = fixture(); receive({ type: 'allLoaded' });
        for (let tick = 0; tick < 513; tick++) {
            frame(1, tick + 1); frame(2, tick + 1); match.tryConsumeTurn(tick);
            match.sendSync(tick, tick); receive(encodeRelayedSyncPacket(1, tick + 1, tick));
        }
        expect(match.fatalError?.message).toBe('Too many pending sync frames.');
    });
});


describe('match shutdown and transport failures', () => {
    test('leaving during a simulation tick prevents trailing sync, orders and load messages', () => {
        const { match, connection, outgoing } = fixture();
        match.submitLocalTurn(0, new Uint8Array());
        connection.close = () => {
            connection.sendRaw = connection.sendImmediate = () => { throw new Error('Not connected to the game server.'); };
        };
        match.leaveRoom();
        expect(() => {
            match.sendSync(0, 123);
            match.submitLocalTurn(1, new Uint8Array());
            match.reportLoadProgress(100);
        }).not.toThrow();
        expect(outgoing).toHaveLength(1);
        expect(match.fatalError).toBeUndefined();
    });
    test('transport loss before close notification becomes a match error for every send path', () => {
        for (const operation of ['orders', 'sync', 'load']) {
            const { match, connection } = fixture();
            connection.sendRaw = connection.sendImmediate = () => { throw new Error('Not connected to the game server.'); };
            const errors: string[] = [];
            match.onFatalError.subscribe(error => errors.push(error.message));
            expect(() => {
                if (operation === 'orders') match.submitLocalTurn(0, new Uint8Array());
                if (operation === 'sync') match.sendSync(0, 123);
                if (operation === 'load') match.reportLoadProgress(100);
            }).not.toThrow();
            connection.onClose.dispatch(connection, 'Later close reason');
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('Connection to the game server was lost');
        }
    });
    test('sync evidence is sent before a fatal listener closes the transport', () => {
        const { match, receive, connection, outgoing } = fixture();
        receive(encodeRelayedSyncPacket(2, 1, 456));
        match.onFatalError.subscribe(() => {
            match.leaveRoom();
            connection.sendRaw = () => { throw new Error('Not connected'); };
        });
        expect(() => match.sendSync(0, 123)).not.toThrow();
        expect(outgoing).toHaveLength(1);
        expect(match.fatalError?.message).toContain('out of sync at frame 1');
    });
});

test('AI replacement is applied only with the authoritative drop turn', () => {
    const {match, receive, frame, outgoing} = fixture();
    match.kickToAi(2);
    expect(JSON.parse(outgoing[0] as string)).toEqual({ type: 'command', name: 'kick_ai', args: {clientId:2, gameId: 'test', generation: 0} });
    receive({type:'allLoaded'});
    receive({type:'disconnect',clientId:2,frame:2,takeover:'ai'});
    frame(1,1);frame(2,1);
    expect(match.tryConsumeTurn(0)?.dropPeerIds).toEqual([]);
    frame(1,2);
    expect(match.tryConsumeTurn(1)?.dropPeerIds).toEqual(['2']);
    expect(match.takesOverWithAi('2')).toBe(true);
});


test('returning to the room retains the socket and blocks trailing simulation sends', () => {
    const { match, outgoing, connection, receive } = fixture();
    let closed = false;
    connection.close = () => { closed = true; };
    match.submitLocalTurn(0, new Uint8Array());
    match.returnToLobby('finished');
    match.returnToLobby('forfeit');
    match.sendSync(0, 42);
    match.submitLocalTurn(1, new Uint8Array());
    match.reportLoadProgress(100);
    receive({ type: 'outOfSync', frame: 1 });
    expect(outgoing).toHaveLength(2);
    expect(JSON.parse(outgoing[1] as string)).toEqual({ type: 'returnToLobby', gameId: 'test', generation: 0, reason: 'finished' });
    expect(closed).toBe(false);
    expect(match.fatalError).toBeUndefined();
});

test('other generations cannot load, drop or desync the current match or fill its frames', () => {
    const { match, receive, frame } = fixture();
    receive({ type: 'allLoaded', generation: 1 });
    receive({ type: 'disconnect', generation: 1, clientId: 2, frame: 1 });
    receive({ type: 'outOfSync', generation: 1, frame: 1 });
    receive(encodeOrderPacket(1, 1, new Uint8Array([99]), 1));
    receive(encodeRelayedSyncPacket(2, 999, 99, 0n, 1));
    expect(match.areAllPlayersLoaded()).toBe(false);
    expect(match.fatalError).toBeUndefined();
    receive({ type: 'allLoaded' });
    frame(2, 1);
    expect(match.tryConsumeTurn(0)).toBeUndefined();
    frame(1, 1);
    expect(match.tryConsumeTurn(0)?.dropPeerIds).toEqual([]);
});
