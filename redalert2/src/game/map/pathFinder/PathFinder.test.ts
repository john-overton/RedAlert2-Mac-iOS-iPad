import { afterEach, expect, test } from 'bun:test';
import { PathFinder } from './PathFinder';
import { Graph } from '@/util/Graph';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';

afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

function fixture() {
    const graph = new Graph<string>();
    const [s, a, b, t, isolated] = ['s', 'a', 'b', 't', 'isolated'].map(id => graph.addNode(id, id));
    s.addLink(a); s.addLink(b); a.addLink(t); b.addLink(t);
    return { graph, s, a, b, t, isolated };
}

test('profiling preserves exact tie route and callback order for repeated and excluded searches', () => {
    const run = (telemetry: boolean) => {
        attachPerformanceOptions(new PerformanceOptions({ telemetry }));
        resetPerformanceTelemetry();
        const { graph } = fixture();
        const callbacks: string[] = [];
        const finder = new PathFinder(graph, {
            bestEffort: true,
            heuristic: (a, b) => { callbacks.push(`h:${a.id}:${b.id}`); return 0; },
            distance: (a, b) => { callbacks.push(`d:${a.id}:${b.id}`); return 1; },
            excludedNodes: data => { callbacks.push(`e:${data}`); return data === 'b'; },
        });
        const paths = ['t', 'isolated', 't', 's'].map(to => finder.find('s', to).map(n => n.id));
        return { paths, callbacks };
    };
    const baseline = run(false);
    expect(baseline.paths).toEqual([['t', 'a', 's'], ['s'], ['t', 'a', 's'], []]);
    expect(run(true)).toEqual(baseline);
    const snapshot = snapshotPerformanceTelemetry();
    expect(snapshot.counters['path.searches']).toBe(4);
    // The isolated destination is never discovered; the four reachable states are reused.
    expect(snapshot.counters['path.stateAllocations']).toBe(4);
});

test('reports actual expansions separately from popped terminal and capped nodes', () => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    resetPerformanceTelemetry();
    const { graph } = fixture();
    new PathFinder(graph, { maxExpandedNodes: 1 }).find('s', 't');
    const counters = snapshotPerformanceTelemetry().counters;
    expect(counters['path.expanded']).toBe(1);
    expect(counters['path.heapPops']).toBe(2);
    expect(counters['path.discovered']).toBe(3);
    expect(counters['path.capped']).toBe(1);
});

test('nested independent finders preserve paths and throwing callbacks are recorded', () => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    resetPerformanceTelemetry();
    const { graph } = fixture();
    let nested = false;
    const finder = new PathFinder(graph, { heuristic: () => {
        if (!nested) {
            nested = true;
            expect(new PathFinder(graph).find('a', 'b').map(n => n.id)).toEqual(['b', 's', 'a']);
        }
        return 0;
    } });
    expect(finder.find('s', 't').map(n => n.id)).toEqual(['t', 'a', 's']);
    const error = new Error('callback failure');
    expect(() => new PathFinder(graph, { heuristic: () => { throw error; } }).find('s', 't')).toThrow(error);
    expect(snapshotPerformanceTelemetry().counters['path.searches']).toBe(3);
    expect(snapshotPerformanceTelemetry().metrics['path.search'].calls).toBe(3);
});
