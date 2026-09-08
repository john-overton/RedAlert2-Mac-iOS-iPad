import { PerformanceOptions, type PerformanceOptionKey, type PerformanceOptionSnapshot, type PerformanceOptionVars, snapshotPerformanceOptions } from '@/performance/PerformanceOptions';

type FrameMetricKind = 'ui' | 'game' | 'scheduler';

interface FrameMetricState {
    lastTimestamp?: number;
    averageMs?: number;
    fps: number | null;
    frameMs: number | null;
    lastSampleAt: number;
}

interface PerformanceMetricState {
    calls: number;
    totalMs: number;
    maxMs: number;
    above16_7Ms: number;
    above33_3Ms: number;
    above50Ms: number;
    samples: number[];
    nextSample: number;
}

/** Totals/max/threshold counts cover the capture; percentiles cover the bounded recent sample window. */
export interface PerformanceMetricSnapshot {
    calls: number;
    totalMs: number;
    avgMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    above16_7Ms: number;
    above33_3Ms: number;
    above50Ms: number;
    retainedSamples: number;
}

export interface PerformanceTelemetrySnapshot {
    enabled: boolean;
    options: PerformanceOptionSnapshot;
    uiFps: number | null;
    uiFrameMs: number | null;
    gameFps: number | null;
    gameFrameMs: number | null;
    metrics: Record<string, PerformanceMetricSnapshot>;
    counters: Record<string, number>;
    trace: PerformanceTraceSample[];
    limits: { metricNames: number; samplesPerMetric: number; traceSamples: number; slowEvents: number };
    updatedAt: number;
    context: Record<string, unknown>;
    slowEvents: PerformanceTraceSample[];
    timeOrigin: number;
}

export interface PerformanceTraceSample {
    kind: 'duration' | 'counter';
    name: string;
    value: number;
    tick?: number;
    atMs?: number;
    gameTimeSeconds?: number;
    context?: Record<string, unknown>;
}

export const PERFORMANCE_TELEMETRY_LIMITS = { metricNames: 128, samplesPerMetric: 2048, traceSamples: 8192, slowEvents: 256 } as const;

const createFrameMetricState = (): FrameMetricState => ({
    fps: null,
    frameMs: null,
    lastSampleAt: 0,
});

class PerformanceTelemetry {
    private readonly metrics = new Map<string, PerformanceMetricState>();
    private readonly counters = new Map<string, number>();
    private readonly trace: PerformanceTraceSample[] = [];
    private nextTrace = 0;
    private readonly slowEvents: PerformanceTraceSample[] = [];
    private nextSlowEvent = 0;
    private readonly context = new Map<string, unknown>();
    private simulationTick?: number;
    private readonly uiFrame = createFrameMetricState();
    private readonly gameFrame = createFrameMetricState();
    private readonly schedulerFrame = createFrameMetricState();

    constructor(private readonly isEnabled: () => boolean) {
    }

    reset(): void {
        this.resetMetrics();
        this.simulationTick = undefined;
        this.resetFrames();
    }

    resetMetrics(): void {
        this.metrics.clear();
        this.counters.clear();
        this.trace.length = 0;
        this.nextTrace = 0;
        this.slowEvents.length = 0;
        this.nextSlowEvent = 0;
    }

    getSimulationTick(): number | undefined { return this.simulationTick; }

    setContext(key: string, value: unknown): void {
        if (!this.isEnabled()) return;
        if (this.context.has(key) || this.context.size < 32) this.context.set(key, value);
    }

    setSimulationTick(tick: number | undefined): void {
        this.simulationTick = tick;
    }

    incrementCounter(name: string, amount: number): void {
        if (!this.isEnabled() || !Number.isFinite(amount)) return;
        if (!this.counters.has(name) && this.counters.size >= PERFORMANCE_TELEMETRY_LIMITS.metricNames) return;
        this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
        this.recordTrace({ kind: 'counter', name, value: amount, tick: this.simulationTick });
    }

    private recordTrace(sample: PerformanceTraceSample): void {
        sample.atMs ??= this.now();
        sample.gameTimeSeconds = sample.tick === undefined ? undefined : sample.tick / 15;
        if (sample.kind === 'duration' && sample.value >= 50) {
            this.slowEvents[this.nextSlowEvent] = { ...sample, context: structuredClone(Object.fromEntries(this.context)) };
            this.nextSlowEvent = (this.nextSlowEvent + 1) % PERFORMANCE_TELEMETRY_LIMITS.slowEvents;
        }
        this.trace[this.nextTrace] = sample;
        this.nextTrace = (this.nextTrace + 1) % PERFORMANCE_TELEMETRY_LIMITS.traceSamples;
    }

    resetFrames(): void {
        Object.assign(this.schedulerFrame, createFrameMetricState(), { lastTimestamp: undefined, averageMs: undefined });
        this.uiFrame.lastTimestamp = undefined;
        this.uiFrame.averageMs = undefined;
        this.uiFrame.fps = null;
        this.uiFrame.frameMs = null;
        this.uiFrame.lastSampleAt = 0;
        this.gameFrame.lastTimestamp = undefined;
        this.gameFrame.averageMs = undefined;
        this.gameFrame.fps = null;
        this.gameFrame.frameMs = null;
        this.gameFrame.lastSampleAt = 0;
    }

    recordFrame(kind: FrameMetricKind, timestamp: number): void {
        if (!this.isEnabled()) {
            return;
        }
        const target = kind === 'ui' ? this.uiFrame : kind === 'game' ? this.gameFrame : this.schedulerFrame;
        if (target.lastTimestamp !== undefined) {
            const delta = timestamp - target.lastTimestamp;
            if (delta > 0) {
                this.recordMetric(`frame.${kind}`, delta);
                if (delta > 1200) {
                    target.averageMs = undefined;
                    target.fps = null;
                    target.frameMs = null;
                }
                else {
                    const smoothing = delta > 200 ? 0.2 : 0.1;
                    target.averageMs = target.averageMs === undefined
                        ? delta
                        : target.averageMs + (delta - target.averageMs) * smoothing;
                    target.frameMs = target.averageMs;
                    target.fps = target.averageMs > 0 ? 1000 / target.averageMs : null;
                }
            }
        }
        target.lastTimestamp = timestamp;
        target.lastSampleAt = this.now();
    }

    measure<T>(metricName: string, callback: () => T): T {
        if (!this.isEnabled()) {
            return callback();
        }
        const tick = this.simulationTick;
        const start = this.now();
        try {
            return callback();
        }
        finally {
            this.recordMetric(metricName, this.now() - start, tick);
        }
    }

    async measureAsync<T>(metricName: string, callback: () => Promise<T>): Promise<T> {
        if (!this.isEnabled()) {
            return callback();
        }
        const tick = this.simulationTick;
        const start = this.now();
        try {
            return await callback();
        }
        finally {
            this.recordMetric(metricName, this.now() - start, tick);
        }
    }

    snapshot(options: PerformanceOptionVars): PerformanceTelemetrySnapshot {
        const metrics = Array.from(this.metrics.entries()).reduce((acc, [key, metric]) => {
            const sorted = metric.samples.slice().sort((a, b) => a - b);
            const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
            acc[key] = {
                calls: metric.calls,
                totalMs: metric.totalMs,
                avgMs: metric.calls ? metric.totalMs / metric.calls : 0,
                medianMs: percentile(0.5),
                p95Ms: percentile(0.95),
                p99Ms: percentile(0.99),
                maxMs: metric.maxMs,
                above16_7Ms: metric.above16_7Ms,
                above33_3Ms: metric.above33_3Ms,
                above50Ms: metric.above50Ms,
                retainedSamples: sorted.length,
            };
            return acc;
        }, {} as Record<string, PerformanceMetricSnapshot>);

        return {
            enabled: this.isEnabled(),
            options: snapshotPerformanceOptions(options),
            uiFps: this.uiFrame.fps,
            uiFrameMs: this.uiFrame.frameMs,
            gameFps: this.gameFrame.fps,
            gameFrameMs: this.gameFrame.frameMs,
            metrics,
            counters: Object.fromEntries(this.counters),
            trace: (this.trace.length < PERFORMANCE_TELEMETRY_LIMITS.traceSamples
                ? this.trace : [...this.trace.slice(this.nextTrace), ...this.trace.slice(0, this.nextTrace)])
                .map(sample => ({ ...sample })),
            limits: { ...PERFORMANCE_TELEMETRY_LIMITS },
            updatedAt: Date.now(),
            timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : 0,
            context: structuredClone(Object.fromEntries(this.context)),
            slowEvents: (this.slowEvents.length < PERFORMANCE_TELEMETRY_LIMITS.slowEvents
                ? this.slowEvents : [...this.slowEvents.slice(this.nextSlowEvent), ...this.slowEvents.slice(0, this.nextSlowEvent)])
                .map(sample => structuredClone(sample)),
        };
    }

    recordMetric(metricName: string, elapsedMs: number, tick: number | null | undefined = this.simulationTick, atMs?: number): void {
        if (!this.isEnabled() || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
        if (!this.metrics.has(metricName) && this.metrics.size >= PERFORMANCE_TELEMETRY_LIMITS.metricNames) return;
        const metric = this.metrics.get(metricName) ?? {
            calls: 0, totalMs: 0, maxMs: 0, above16_7Ms: 0, above33_3Ms: 0, above50Ms: 0,
            samples: [], nextSample: 0,
        };
        metric.calls += 1;
        metric.totalMs += elapsedMs;
        metric.maxMs = Math.max(metric.maxMs, elapsedMs);
        if (elapsedMs > 16.7) metric.above16_7Ms++;
        if (elapsedMs > 33.3) metric.above33_3Ms++;
        if (elapsedMs > 50) metric.above50Ms++;
        metric.samples[metric.nextSample] = elapsedMs;
        metric.nextSample = (metric.nextSample + 1) % PERFORMANCE_TELEMETRY_LIMITS.samplesPerMetric;
        this.metrics.set(metricName, metric);
        this.recordTrace({ kind: 'duration', name: metricName, value: elapsedMs, tick: tick ?? undefined, atMs: atMs ?? this.now() - elapsedMs });
    }

    private now(): number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }
}

let performanceOptions: PerformanceOptionVars = new PerformanceOptions();
let captureGeneration = 0;

const telemetry = new PerformanceTelemetry(() => performanceOptions.telemetry.value);
// Never count time spent with diagnostics disabled as a slow frame on resuming.
let longTaskObserver: PerformanceObserver | undefined;
const handleTelemetryToggle = () => {
    captureGeneration++;
    telemetry.resetFrames();
    longTaskObserver?.disconnect();
    longTaskObserver = undefined;
    if (!performanceOptions.telemetry.value) return;
    const supported = typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes?.includes('longtask');
    telemetry.setContext('longTasks', { supported: Boolean(supported) });
    if (supported) {
        try {
            longTaskObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    // Delivered asynchronously: the current simulation tick is not its original tick.
                    telemetry.recordMetric('browser.longTask', entry.duration, null, entry.startTime);
                }
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch { telemetry.setContext('longTasks', { supported: false }); }
    }
};
performanceOptions.telemetry.onChange.subscribe(handleTelemetryToggle);

export function attachPerformanceOptions(options: PerformanceOptionVars): void {
    if (options === performanceOptions) return;
    performanceOptions.telemetry.onChange.unsubscribe(handleTelemetryToggle);
    performanceOptions = options;
    performanceOptions.telemetry.onChange.subscribe(handleTelemetryToggle);
    handleTelemetryToggle();
}

export function getPerformanceOptions(): PerformanceOptionVars {
    return performanceOptions;
}

export function snapshotPerformanceConfig(): PerformanceOptionSnapshot {
    return snapshotPerformanceOptions(performanceOptions);
}

export function isPerformanceFeatureEnabled(feature: Exclude<PerformanceOptionKey, 'telemetry'>): boolean {
    return performanceOptions[feature].value;
}

export function measurePerformanceFeature<T>(feature: Exclude<PerformanceOptionKey, 'telemetry'>, callback: () => T): T {
    return telemetry.measure(feature, callback);
}

export function measurePerformanceMetric<T>(metricName: string, callback: () => T): T {
    return telemetry.measure(metricName, callback);
}

export async function measurePerformanceMetricAsync<T>(metricName: string, callback: () => Promise<T>): Promise<T> {
    return telemetry.measureAsync(metricName, callback);
}

export function recordUiPerformanceFrame(timestamp: number): void {
    telemetry.recordFrame('ui', timestamp);
}

export function recordGamePerformanceFrame(timestamp: number): void {
    telemetry.recordFrame('game', timestamp);
}

export function resetPerformanceTelemetry(): void {
    captureGeneration++;
    longTaskObserver?.takeRecords();
    telemetry.reset();
}

export function resetPerformanceMetricSamples(): void {
    captureGeneration++;
    longTaskObserver?.takeRecords();
    telemetry.resetMetrics();
}

export function snapshotPerformanceTelemetry(): PerformanceTelemetrySnapshot {
    return telemetry.snapshot(performanceOptions);
}

export function installPerformanceDebugApi(target: Record<string, any>): void {
    target.performance = {
        reset: () => resetPerformanceTelemetry(),
        snapshot: () => snapshotPerformanceTelemetry(),
        getOptions: () => snapshotPerformanceConfig(),
        setEnabled: (feature: PerformanceOptionKey, enabled: boolean) => {
            if (!(feature in performanceOptions)) {
                throw new Error(`Unknown performance option "${feature}"`);
            }
            performanceOptions[feature].value = enabled;
        },
    };
}

/** Labels use the most recently entered authoritative tick; render work may retain that label.
 * Diagnostic only: never participates in simulation state. */
export function setPerformanceSimulationTick(tick: number | undefined): void {
    telemetry.setSimulationTick(tick);
}

export function incrementPerformanceCounter(name: string, amount = 1): void {
    telemetry.incrementCounter(name, amount);
}

export function recordPerformanceDuration(name: string, elapsedMs: number, tick?: number, atMs?: number): void {
    telemetry.recordMetric(name, elapsedMs, tick, atMs);
}

export function isPerformanceTelemetryEnabled(): boolean {
    return performanceOptions.telemetry.value;
}


export function getPerformanceSimulationTick(): number | undefined {
    return telemetry.getSimulationTick();
}

export function setPerformanceContext(key: string, value: unknown): void {
    telemetry.setContext(key, value);
}

export function downloadPerformanceReport(): void {
    const report = {
        schemaVersion: 1,
        description: 'Local slowdown diagnostics. Nested timings overlap; peer waits do not prove network latency. Uninstrumented CPU, GPU, OS scheduling and GC may remain unattributed.',
        userAgent: navigator.userAgent,
        ...snapshotPerformanceTelemetry(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ra2-slowdown-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function recordSchedulerPerformanceFrame(timestamp: number): void {
    telemetry.recordFrame('scheduler', timestamp);
}

export function getPerformanceCaptureGeneration(): number {
    return captureGeneration;
}
