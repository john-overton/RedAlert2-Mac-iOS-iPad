import { afterEach, expect, spyOn, test } from 'bun:test';
import { EventDispatcher } from '@/util/event';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';
// Initialize the engine's movement inheritance cycle before importing Game.
import '@/game/gameobject/task/harvester/TeleportMoveToRefineryTask';
import { GameStatus } from '@/game/Game';
import { NetworkMatchSession } from './NetworkMatchSession';
import { NetworkTurnManager } from './NetworkTurnManager';
import { encodeOrderPacket } from '@/network/server/Protocol';

afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

function run(profiling: boolean) {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: profiling }));
    resetPerformanceTelemetry();
    let now = 1000;
    const date = spyOn(Date, 'now').mockImplementation(() => now);
    const outgoing: any[] = [];
    const connection: any = {
        onMessage: new EventDispatcher(), onClose: new EventDispatcher(),
        sendRaw: (data: Uint8Array) => outgoing.push([...data]), sendImmediate: (data: any) => outgoing.push(data), close() {},
    };
    const start: any = { type: 'startGame', gameId: 'diagnostic', generation: 0, clientIds: [1, 2], orderLatency: 2, netFrameInterval: 1 };
    const descriptor: any = { gameId: 'diagnostic', localPeerId: '1', hostPeerId: '1', humanAssignments: [{ peerId: '1', name: 'Alice' }, { peerId: '2', name: 'Bob' }] };
    const match = new NetworkMatchSession(connection, start, descriptor);
    const game: any = { currentTick: 0, status: GameStatus.Started, speed: { value: 1 }, update() { this.currentTick++; }, getHash: () => 123, getPlayerByName: (name: string) => ({ name }) };
    const manager = new NetworkTurnManager(game, {}, { dequeueAll: () => [] }, {}, match);
    const receive = (message: any) => connection.onMessage.dispatch(connection, typeof message === 'string' || message instanceof Uint8Array ? message : JSON.stringify({ generation: 0, ...message }));
    const lagChanges: boolean[] = [];
    manager.onLagStateChange.subscribe(value => lagChanges.push(value));
    manager.init();
    try {
        expect(manager.doGameTurn(0)).toBe(false);
        const loading = snapshotPerformanceTelemetry().context.network;
        receive({ type: 'allLoaded' }); receive(encodeOrderPacket(1, 1, new Uint8Array()));
        expect(manager.doGameTurn(0)).toBe(false);
        now += 75;
        expect(manager.doGameTurn(0)).toBe(false);
        const waiting = snapshotPerformanceTelemetry().context.network;
        now += 45;
        receive(encodeOrderPacket(2, 1, new Uint8Array()));
        expect(manager.doGameTurn(0)).toBe(true);
        const telemetry = snapshotPerformanceTelemetry();
        return { loading, waiting, telemetry, outgoing, lagChanges, tick: game.currentTick };
    } finally { manager.dispose(); date.mockRestore(); }
}

test('wait context identifies missing relayed orders and reports completed wait separately from RTT', () => {
    const { loading, waiting, telemetry, lagChanges, tick } = run(true);
    expect((loading as any).state).toBe('loading');
    expect((waiting as any).state).toBe('waiting-for-relayed-turn');
    expect((waiting as any).missingPeerIds).toEqual(['2']);
    expect((waiting as any).waitingMs).toBe(75);
    expect((waiting as any).serverHealthAgeMs).toBeNull();
    const final = telemetry.context.network as any;
    expect(final.state).toBe('running');
    expect(final.missingPeerIds).toEqual([]);
    expect(final.waitingMs).toBe(0);
    expect(final.lastWait).toEqual({ tick: 0, elapsedMs: 120, initiallyMissingPeerIds: ['2'] });
    expect(telemetry.metrics['network.wait'].totalMs).toBe(120);
    expect(telemetry.counters['network.waitEpisodes']).toBe(1);
    expect(telemetry.counters['network.pendingTurnPolls']).toBe(2);
    expect(lagChanges).toEqual([true, false]);
    expect(tick).toBe(1);
});

test('profiling preserves protocol sends, action consumption and simulation progress', () => {
    const enabled = run(true), disabled = run(false);
    expect(enabled.outgoing).toEqual(disabled.outgoing);
    expect(enabled.lagChanges).toEqual(disabled.lagChanges);
    expect(enabled.tick).toBe(disabled.tick);
    expect(disabled.telemetry.metrics['network.wait']).toBeUndefined();
});
