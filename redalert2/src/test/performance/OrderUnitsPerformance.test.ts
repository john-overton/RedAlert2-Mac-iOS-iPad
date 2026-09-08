// Initialize Infantry before movement tasks to resolve the existing module cycle.
import '@/game/gameobject/Infantry';
import { afterEach, expect, test } from 'bun:test';
import { DataStream } from '@/data/DataStream';
import { OrderUnitsAction, ORDER_UNIT_LIMIT } from '@/game/action/OrderUnitsAction';
import { SelectUnitsAction } from '@/game/action/SelectUnitsAction';
import { OrderType } from '@/game/order/OrderType';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';

afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

function runOrder(telemetry: boolean) {
    attachPerformanceOptions(new PerformanceOptions({ telemetry }));
    resetPerformanceTelemetry();
    const callbacks: string[] = [];
    const dispatched: number[] = [];
    const player = {};
    const units = Array.from({ length: ORDER_UNIT_LIMIT + 12 }, (_, id) => ({
        id,
        owner: player,
        rules: {},
        warpedOutTrait: { isActive: () => false },
        unitOrderTrait: {
            addOrder(order: any, queue: boolean) {
                callbacks.push(`dispatch:${order.sourceObject.id}:${order.orderType}:${queue}`);
                dispatched.push(order.sourceObject.id);
            },
        },
    }));
    const selection = { getSelectedUnits: () => units };
    const context = { getOrCreateSelection: () => selection };
    const factory = {
        create(orderType: OrderType) {
            callbacks.push(`create:${orderType}`);
            return {
                orderType,
                sourceObject: undefined as any,
                targetOptional: true,
                set(unit: any) { this.sourceObject = unit; },
                isValid() {
                    callbacks.push(`validate:${this.sourceObject.id}:${orderType}`);
                    // Half the units use the requested stop; the rest try two
                    // rejected fallback orders before accepting attack.
                    return orderType === OrderType.Stop
                        ? this.sourceObject.id % 2 === 0 : orderType === OrderType.Attack;
                },
                isAllowed() {
                    callbacks.push(`allow:${this.sourceObject.id}:${orderType}`);
                    return true;
                },
            };
        },
    };
    const game = { currentTick: 27, mapShroudTrait: { getPlayerShroud: () => ({}) } };
    const action = new OrderUnitsAction(game, {}, context, factory);
    action.player = player;
    action.orderType = OrderType.Stop;
    action.process();
    return { callbacks, dispatched, telemetry: snapshotPerformanceTelemetry() };
}

test('oversized orders validate every unit and fallback before dispatching the first 128, identically with profiling on/off', () => {
    const disabled = runOrder(false);
    const enabled = runOrder(true);
    expect(enabled.callbacks).toEqual(disabled.callbacks);
    expect(enabled.dispatched).toEqual(Array.from({ length: ORDER_UNIT_LIMIT }, (_, id) => id));
    expect(disabled.dispatched).toEqual(enabled.dispatched);
    const firstDispatch = enabled.callbacks.findIndex(callback => callback.startsWith('dispatch:'));
    expect(enabled.callbacks.indexOf(`validate:139:${OrderType.Stop}`)).toBeLessThan(firstDispatch);
    expect(enabled.callbacks.indexOf(`allow:139:${OrderType.Attack}`)).toBeLessThan(firstDispatch);
    expect(enabled.callbacks.filter(callback => callback.startsWith('validate:139:'))).toEqual([
        `validate:139:${OrderType.Stop}`,
        `validate:139:${OrderType.Occupy}`,
        `validate:139:${OrderType.Dock}`,
        `validate:139:${OrderType.Attack}`,
    ]);
    expect(enabled.telemetry.counters['order.selected']).toBe(140);
    expect(enabled.telemetry.counters['order.validatedBeforeCap']).toBe(140);
    expect(enabled.telemetry.counters['order.accepted']).toBe(128);
    expect(enabled.telemetry.counters['order.dispatched']).toBe(128);
    expect(enabled.telemetry.counters['order.fallbackCandidates']).toBe(210);
    expect(enabled.telemetry.trace.every(sample => sample.tick === 27)).toBe(true);
    expect(disabled.telemetry.metrics).toEqual({});
    expect(disabled.telemetry.counters).toEqual({});
});

test('selection assignment caps at 128 but existing oversized deserialization retains all IDs', () => {
    const units = Array.from({ length: ORDER_UNIT_LIMIT + 12 }, (_, id) => ({ id }));
    let selected: any[] = [];
    const player = { getOwnedObjects: () => units };
    const action = new SelectUnitsAction({}, {
        getOrCreateSelection: () => ({ update: (value: any[]) => { selected = value; } }),
    } as any);
    action.player = player;
    action.unitIds = units.map(unit => unit.id);
    expect(action.unitIds.length).toBe(ORDER_UNIT_LIMIT);

    const stream = new DataStream(units.length * 4);
    units.forEach(unit => stream.writeUint32(unit.id));
    action.unserialize(stream.toUint8Array());
    // Document the wire behavior without silently changing multiplayer semantics.
    expect(action.unitIds).toEqual(units.map(unit => unit.id));
    action.process();
    expect(selected).toEqual(units);
});
