import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PerformanceOptions } from '@/performance/PerformanceOptions';
import { attachPerformanceOptions, incrementPerformanceCounter, measurePerformanceMetric, PERFORMANCE_TELEMETRY_LIMITS, recordPerformanceDuration, recordGamePerformanceFrame, resetPerformanceTelemetry, setPerformanceSimulationTick, setPerformanceContext, snapshotPerformanceTelemetry } from '@/performance/PerformanceRuntime';

beforeEach(() => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: true }));
    resetPerformanceTelemetry();
});
afterEach(() => {
    attachPerformanceOptions(new PerformanceOptions());
    resetPerformanceTelemetry();
});

test('profiling preserves return values and thrown errors; labels outer measurements with their starting tick', () => {
    setPerformanceSimulationTick(17);
    const result = measurePerformanceMetric('outer', () => {
        incrementPerformanceCounter('searches', 3);
        setPerformanceSimulationTick(18);
        return 42;
    });
    expect(result).toBe(42);
    const error = new Error('test');
    expect(() => measurePerformanceMetric('throws', () => { throw error; })).toThrow(error);
    const snapshot = snapshotPerformanceTelemetry();
    expect(snapshot.counters.searches).toBe(3);
    expect(snapshot.trace.find(sample => sample.name === 'outer')?.tick).toBe(17);
    expect(snapshot.metrics.throws.calls).toBe(1);
});

test('reports nearest-rank percentiles and lifetime threshold counts', () => {
    for (let duration = 1; duration <= 100; duration++) recordPerformanceDuration('duration', duration);
    expect(snapshotPerformanceTelemetry().metrics.duration).toEqual({
        calls: 100, totalMs: 5050, avgMs: 50.5, medianMs: 50, p95Ms: 95, p99Ms: 99, maxMs: 100,
        above16_7Ms: 84, above33_3Ms: 67, above50Ms: 50, retainedSamples: 100,
    });
});

test('samples and name cardinality stay bounded and snapshots cannot mutate retained traces', () => {
    for (let tick = 0; tick < PERFORMANCE_TELEMETRY_LIMITS.traceSamples + 10; tick++) {
        setPerformanceSimulationTick(tick);
        recordPerformanceDuration('duration', tick);
    }
    for (let i = 0; i < 256; i++) {
        recordPerformanceDuration(`metric${i}`, 1);
        incrementPerformanceCounter(`counter${i}`);
    }
    const snapshot = snapshotPerformanceTelemetry();
    expect(snapshot.trace.length).toBe(PERFORMANCE_TELEMETRY_LIMITS.traceSamples);
    expect(snapshot.metrics.duration.retainedSamples).toBe(PERFORMANCE_TELEMETRY_LIMITS.samplesPerMetric);
    expect(Object.keys(snapshot.metrics).length).toBe(PERFORMANCE_TELEMETRY_LIMITS.metricNames);
    expect(Object.keys(snapshot.counters).length).toBe(PERFORMANCE_TELEMETRY_LIMITS.metricNames);
    snapshot.trace[0].name = 'mutated';
    expect(snapshotPerformanceTelemetry().trace[0].name).not.toBe('mutated');
    resetPerformanceTelemetry();
    expect(snapshotPerformanceTelemetry().trace).toEqual([]);
    expect(snapshotPerformanceTelemetry().counters).toEqual({});
});

test('disabled telemetry records no work while running callbacks exactly once', () => {
    attachPerformanceOptions(new PerformanceOptions({ telemetry: false }));
    let calls = 0;
    measurePerformanceMetric('disabled', () => { calls++; });
    recordPerformanceDuration('disabled', 100);
    incrementPerformanceCounter('disabled');
    expect(calls).toBe(1);
    expect(snapshotPerformanceTelemetry().metrics).toEqual({});
    expect(snapshotPerformanceTelemetry().trace).toEqual([]);
    expect(snapshotPerformanceTelemetry().counters).toEqual({});
});


test('saved diagnostics toggle gates live collection and excludes time spent disabled', () => {
    const options = new PerformanceOptions();
    attachPerformanceOptions(options);
    recordGamePerformanceFrame(0);
    recordGamePerformanceFrame(100);
    expect(snapshotPerformanceTelemetry().enabled).toBe(false);
    expect(snapshotPerformanceTelemetry().metrics).toEqual({});

    options.telemetry.value = true;
    recordGamePerformanceFrame(200);
    recordGamePerformanceFrame(216);
    measurePerformanceMetric('network.hash', () => 42);
    const enabled = snapshotPerformanceTelemetry();
    expect(enabled.enabled).toBe(true);
    expect(enabled.metrics['frame.game'].calls).toBe(1);

    options.telemetry.value = false;
    recordGamePerformanceFrame(5000);
    measurePerformanceMetric('network.hash', () => 42);
    incrementPerformanceCounter('network.wait.pendingPolls');
    expect(snapshotPerformanceTelemetry().metrics).toEqual(enabled.metrics);
    expect(snapshotPerformanceTelemetry().trace).toEqual(enabled.trace);
    expect(snapshotPerformanceTelemetry().counters).toEqual(enabled.counters);

    options.telemetry.value = true;
    recordGamePerformanceFrame(10000);
    recordGamePerformanceFrame(10016);
    expect(snapshotPerformanceTelemetry().metrics['frame.game'].calls).toBe(2);
    expect(snapshotPerformanceTelemetry().metrics['frame.game'].maxMs).toBe(16);
});


test('slow events survive busy recent traces with original tick and context, and remain bounded', () => {
    setPerformanceSimulationTick(1800);
    setPerformanceContext('network', { waitingForPeers: [2] });
    recordPerformanceDuration('network.wait', 150);
    setPerformanceContext('network', { waitingForPeers: [] });
    for (let i = 0; i < PERFORMANCE_TELEMETRY_LIMITS.traceSamples + 1; i++) {
        recordPerformanceDuration('fast', 1);
    }
    const snapshot = snapshotPerformanceTelemetry();
    expect(snapshot.trace.some(event => event.name === 'network.wait')).toBe(false);
    expect(snapshot.slowEvents[0].gameTimeSeconds).toBe(120);
    expect(snapshot.slowEvents[0].context?.network).toEqual({ waitingForPeers: [2] });
    expect(Number.isFinite(snapshot.slowEvents[0].atMs)).toBe(true);
    (snapshot.slowEvents[0].context!.network as any).waitingForPeers.push(9);
    expect(snapshotPerformanceTelemetry().slowEvents[0].context?.network).toEqual({ waitingForPeers: [2] });
    for (let i = 0; i < PERFORMANCE_TELEMETRY_LIMITS.slowEvents + 10; i++) recordPerformanceDuration('slow', 100);
    expect(snapshotPerformanceTelemetry().slowEvents).toHaveLength(PERFORMANCE_TELEMETRY_LIMITS.slowEvents);
    resetPerformanceTelemetry();
    expect(snapshotPerformanceTelemetry().slowEvents).toEqual([]);
});
