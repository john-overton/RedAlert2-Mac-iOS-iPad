import { afterEach, expect, test } from 'bun:test';
import { MovePositionHelper } from '@/game/gameobject/unit/MovePositionHelper';
import { MovementZone } from '@/game/type/MovementZone';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';

function fixture() {
    const tiles = new Map<string, any>();
    const tile = (rx: number, ry: number) => {
        const key = `${rx},${ry}`;
        if (!tiles.has(key)) tiles.set(key, { rx, ry, z: 0 });
        return tiles.get(key);
    };
    const map = {
        tiles: { getByMapCoords: tile },
        mapBounds: { isWithinBounds: () => true },
        tileOccupation: { getBridgeOnTile: () => undefined as any },
        terrain: { getPassableSpeed: () => true },
    };
    const unit = (x: number, y: number, infantry = false, movementZone = MovementZone.Normal) => ({
        tile: tile(x, y), rules: { movementZone }, isInfantry: () => infantry,
    });
    return { map, tile, unit, helper: new MovePositionHelper(map) };
}

afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

test('formation diagnostics preserve assignment and iteration order for capped and larger selections', () => {
    for (const count of [1, 10, 30, 60, 128, 160]) {
        const { unit, tile, helper } = fixture();
        const units = Array.from({ length: count }, (_, i) => unit(i % 12, Math.floor(i / 12)));
        attachPerformanceOptions(new PerformanceOptions({ telemetry: false }));
        const baseline = [...helper.findPositions(units, tile(30, 30), undefined, false)];
        resetPerformanceTelemetry();
        attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
        const profiled = [...helper.findPositions(units, tile(30, 30), undefined, false)];
        expect(profiled).toEqual(baseline);
        expect(new Set(profiled.map(([, dest]) => dest)).size).toBe(count);
        const counters = snapshotPerformanceTelemetry().counters;
        expect(counters['formation.units']).toBe(count);
        expect(counters['formation.fallbackUnits']).toBe(0);
    }
});

test('crowded infantry retains three slots and radial leftovers retain input order', () => {
    const { unit, tile, helper } = fixture();
    const units = Array.from({ length: 5 }, () => unit(1, 1, true));
    const assignments = helper.findPositions(units, tile(20, 20), undefined, false);
    expect(units.map(obj => assignments.get(obj))).toEqual([
        tile(20, 20), tile(20, 20), tile(20, 20), tile(21, 21), tile(20, 21),
    ]);
});

test('exhausted placement counts every shared clicked-tile fallback', () => {
    const { map, unit, tile, helper } = fixture();
    map.mapBounds.isWithinBounds = () => false;
    const units = Array.from({ length: 30 }, (_, i) => unit(i * 3, 0));
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    const assignments = helper.findPositions(units, tile(20, 20), undefined, false);
    expect([...assignments.keys()]).toEqual(units);
    expect([...assignments.values()].every(dest => dest === tile(20, 20))).toBe(true);
    expect(snapshotPerformanceTelemetry().counters['formation.fallbackUnits']).toBe(30);
});

test('naval destination remains under a high bridge while ground units match its deck', () => {
    const { map, unit, tile, helper } = fixture();
    const bridge = { isHighBridge: () => true, tileElevation: 4 };
    const destination = tile(20, 20);
    destination.onBridgeLandType = true;
    map.tileOccupation.getBridgeOnTile = () => bridge;
    const ship = unit(1, 1, false, MovementZone.Water);
    expect(helper.findPositions([ship], destination, undefined, false).get(ship)).toBe(destination);
    const tank = unit(1, 1);
    expect(helper.findPositions([tank], destination, bridge, false).get(tank)).toBe(destination);
    expect(helper.isEligibleTile(destination, bridge, undefined, destination)).toBe(false);
});
