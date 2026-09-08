import { afterEach, expect, test } from 'bun:test';
import { Terrain } from './Terrain';
import { Graph } from '@/util/Graph';
import { SpeedType } from '@/game/type/SpeedType';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';

afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

// Real computePath and A* with an explicit graph. Graph construction/occupation
// are stubbed to isolate the historical forced-start, unreachable-end branch.
function fallbackFixture() {
    const tiles = Array.from({ length: 701 }, (_, rx) => ({ id: String(rx), rx, ry: 0, z: 0 }));
    const graph = new Graph<any>();
    for (let i = 1; i <= 600; i++) {
        const node = graph.addNode(String(i), { tile: tiles[i] });
        if (i > 1) node.addLink(graph.getNode(String(i - 1))!);
    }
    const updates: { ignored: number; forced: boolean }[] = [];
    const terrain = new Terrain({ getByMapCoords: () => undefined } as any, undefined,
        { onLocalResize: { subscribe() {} }, isWithinBounds: () => true } as any,
        { onChange: { subscribe() {} }, getBridgeOnTile: () => undefined, calculateTilesForGameObject: (tile: any) => [tile] } as any,
        {} as any);
    (terrain as any).computePassabilityGraph = () => graph;
    (terrain as any).getPassableSpeed = () => 0;
    (terrain as any).updatePassability = (_tiles: any, _speed: any, _bridge: any, _graph: any, ignored = [], forced?: number) => {
        updates.push({ ignored: ignored.length, forced: !!forced });
        if (forced) graph.getNode('0')!.addLink(graph.getNode('1')!);
    };
    const search = (options = {}) => terrain.computePath(SpeedType.Foot, false, tiles[0] as any, false, tiles[700] as any, false, options);
    return { tiles, graph, updates, terrain, search };
}

test('reproduces ineffective fallback cap without silently changing best-effort routes', () => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    resetPerformanceTelemetry();
    const f = fallbackFixture();
    const unlimited = f.search();
    expect(unlimited.length).toBe(601);
    expect(unlimited[0].tile.id).toBe('600');
    expect(snapshotPerformanceTelemetry().counters['path.expanded']).toBe(601);
    expect(snapshotPerformanceTelemetry().counters['terrain.fallbackCapCandidates']).toBe(1);
    resetPerformanceTelemetry();
    const capped = f.search({ maxExpandedNodes: 500 });
    expect(capped.length).toBe(501);
    expect(capped[0].tile.id).toBe('500');
    expect(snapshotPerformanceTelemetry().counters['path.expanded']).toBe(500);
    expect(f.graph.hasNode('0')).toBe(false);
    expect(f.graph.hasNode('700')).toBe(false);
    expect(f.graph.getNodeCount()).toBe(600);
});

test('temporary endpoints and ignored blockers are cleaned after a callback throws', () => {
    const f = fallbackFixture();
    const error = new Error('exclude failed');
    expect(() => f.search({ ignoredBlockers: [{ tile: f.tiles[5] }] as any, excludeTiles: () => { throw error; } })).toThrow(error);
    expect(f.graph.hasNode('0')).toBe(false);
    expect(f.graph.hasNode('700')).toBe(false);
    expect(f.graph.getNode('1')!.neighbors.size).toBe(1);
    expect(f.updates).toEqual([
        { ignored: 1, forced: false }, { ignored: 1, forced: true },
        { ignored: 0, forced: false }, { ignored: 0, forced: false },
    ]);
    expect(f.search().length).toBe(601);
});

test('profiling on/off preserves fallback routes and callback sequence', () => {
    const run = (telemetry: boolean) => {
        attachPerformanceOptions(new PerformanceOptions({ telemetry }));
        const f = fallbackFixture();
        const calls: string[] = [];
        const path = f.search({ excludeTiles: ({ tile }: any) => { calls.push(tile.id); return false; } });
        return { path: path.map(n => n.tile.id), calls };
    };
    expect(run(true)).toEqual(run(false));
});

test('nested Terrain query leaves outer temporary endpoints intact until outer cleanup', () => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    const f = fallbackFixture();
    let nested = false;
    const path = f.search({ excludeTiles: () => {
        if (!nested) {
            nested = true;
            expect(f.search({ maxExpandedNodes: 10 }).length).toBe(11);
            expect(f.graph.hasNode('0')).toBe(true);
            expect(f.graph.hasNode('700')).toBe(true);
        }
        return false;
    } });
    expect(path.length).toBe(601);
    expect(f.graph.hasNode('0')).toBe(false);
    expect(f.graph.hasNode('700')).toBe(false);
});
