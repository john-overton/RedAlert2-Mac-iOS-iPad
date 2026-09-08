/** Direct engine-component diagnostic; this is not a full game or native-runtime benchmark. */
import { PathFinder } from '../../redalert2/src/game/map/pathFinder/PathFinder';
import { Graph } from '../../redalert2/src/util/Graph';
import { cpus, platform, arch } from 'node:os';
import { PerformanceOptions } from '../../redalert2/src/performance/PerformanceOptions';
import { attachPerformanceOptions, resetPerformanceTelemetry, snapshotPerformanceTelemetry } from '../../redalert2/src/performance/PerformanceRuntime';

const telemetry = process.env.PATHFINDER_TELEMETRY === '1';
attachPerformanceOptions(new PerformanceOptions({ telemetry }));

const alternateModule = process.env.PATHFINDER_MODULE;
const Finder = alternateModule ? (await import(alternateModule)).PathFinder : PathFinder;
const graph = new Graph<{ x: number; y: number }>();
const side = 64;
for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
        const node = graph.addNode(`${x},${y}`, { x, y });
        if (x > 0 && (x !== 32 || y === 60)) node.addLink(graph.getNode(`${x - 1},${y}`)!);
        if (y > 0) node.addLink(graph.getNode(`${x},${y - 1}`)!);
    }
}
graph.addNode('unreachable', { x: 70, y: 32 });
const options = {
    bestEffort: true,
    heuristic: (a: any, b: any) => Math.abs(a.data.x - b.data.x) + Math.abs(a.data.y - b.data.y),
};
const repetitions = 7;
const rows: any[] = [];
for (const destination of ['63,0', 'unreachable']) {
    for (const count of [1, 10, 30, 60, 128]) {
        resetPerformanceTelemetry();
        const run = () => {
            const started = performance.now();
            let pathChecksum = 2166136261;
            for (let i = 0; i < count; i++) {
                const path = new Finder(graph, options).find(`0,${i % side}`, destination);
                for (const node of path) {
                    for (let c = 0; c < node.id.length; c++) pathChecksum = Math.imul(pathChecksum ^ node.id.charCodeAt(c), 16777619);
                }
            }
            return { ms: performance.now() - started, pathChecksum: pathChecksum >>> 0 };
        };
        const cold = run();
        for (let warmup = 0; warmup < 10; warmup++) run();
        const samples = Array.from({ length: repetitions }, run);
        const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
        rows.push({ destination, count, cold, samples, medianMs: sorted[3], p95Ms: sorted[6], counters: snapshotPerformanceTelemetry().counters });
    }
}
console.log(JSON.stringify({ diagnostic: 'Direct PathFinder with fresh finder per query as Terrain currently uses. No rendering, networking, formations, real map, or game ticks.', variant: alternateModule ?? 'working-tree', telemetry, runtime: `Bun ${Bun.version}`, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, graphNodes: graph.getNodeCount(), repetitions, rows }, null, 2));
