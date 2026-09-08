import { expect, test } from 'bun:test';
import { GpuTimer, MAX_PENDING_GPU_QUERIES } from './GpuTimer';

function fixture(supported = true) {
    let nextId = 0;
    let current: any = null;
    let disjoint = false;
    let extensions = 0;
    const queries: any[] = [];
    const samples: { milliseconds: number; tick?: number }[] = [];
    const sampleStarts: number[] = [];
    const extension = { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 };
    const gl = {
        CURRENT_QUERY: 1, QUERY_RESULT_AVAILABLE: 2, QUERY_RESULT: 3,
        getExtension() { extensions++; return supported ? extension : null; },
        createQuery() {
            const query = { id: nextId++, available: false, deleted: false, value: 2_500_000 };
            queries.push(query);
            return query;
        },
        beginQuery(_target: number, query: any) { expect(current).toBeNull(); current = query; },
        endQuery() { expect(current).not.toBeNull(); current = null; },
        getParameter() { return disjoint; },
        getQuery() { return current; },
        getQueryParameter(query: any, name: number) {
            if (name === this.QUERY_RESULT_AVAILABLE) return query.available;
            if (!query.available) throw new Error('Would block on unavailable result');
            return query.value;
        },
        deleteQuery(query: any) { query.deleted = true; },
    };
    return {
        timer: new GpuTimer(gl as any, (milliseconds, tick, startedAt) => {
            samples.push({ milliseconds, tick });
            sampleStarts.push(startedAt);
        }),
        gl, queries, samples, sampleStarts,
        disjoint: () => { disjoint = true; },
        extensions: () => extensions,
    };
}

test('GPU instrumentation is lazy when disabled and reports unsupported contexts', () => {
    const f = fixture(false);
    f.timer.begin(false, 0);
    f.timer.end();
    expect(f.extensions()).toBe(0);
    expect(f.queries).toHaveLength(0);
    expect(f.timer.snapshot().status).toBe('disabled');
    f.timer.begin(true, 0);
    expect(f.timer.snapshot().status).toBe('unsupported');
    f.timer.begin(true, 1);
    expect(f.extensions()).toBe(1);
});

test('GPU samples resolve on later frames with original tick and nanoseconds converted to milliseconds', () => {
    const f = fixture();
    f.timer.begin(true, 17);
    f.timer.end();
    f.timer.begin(true, 18);
    f.timer.end();
    expect(f.samples).toEqual([]);
    f.queries[0].available = true;
    const beforeDelivery = performance.now();
    f.timer.begin(true, 19);
    f.timer.end();
    expect(f.samples).toEqual([{ milliseconds: 2.5, tick: 17 }]);
    expect(f.sampleStarts[0]).toBeLessThanOrEqual(beforeDelivery);
    expect(f.queries[0].deleted).toBe(true);
    f.timer.dispose();
    expect(f.queries.every(query => query.deleted)).toBe(true);
});

test('pending GPU queries are bounded and disabling deletes them without reading unavailable results', () => {
    const f = fixture();
    for (let tick = 0; tick < 100; tick++) {
        f.timer.begin(true, tick);
        f.timer.end();
    }
    expect(f.queries.length).toBe(MAX_PENDING_GPU_QUERIES);
    expect(f.timer.snapshot().pendingQueries).toBe(MAX_PENDING_GPU_QUERIES);
    expect(f.timer.snapshot().droppedQueries).toBe(100 - MAX_PENDING_GPU_QUERIES);
    f.timer.begin(false);
    expect(f.timer.snapshot().pendingQueries).toBe(0);
    expect(f.queries.every(query => query.deleted)).toBe(true);
    expect(f.samples).toEqual([]);
});

test('disjoint results are discarded even when available', () => {
    const f = fixture();
    f.timer.begin(true, 17);
    f.timer.end();
    f.queries[0].available = true;
    f.disjoint();
    f.timer.begin(true, 18);
    expect(f.samples).toEqual([]);
    expect(f.queries[0].deleted).toBe(true);
    expect(f.timer.snapshot().status).toBe('disjoint');
    expect(f.timer.snapshot().pendingQueries).toBe(0);
});

test('context loss abandons invalid queries and diagnostics cannot throw into rendering', () => {
    const f = fixture();
    f.timer.begin(true, 17);
    f.timer.contextLost();
    f.gl.endQuery = () => { throw new Error('lost'); };
    f.gl.deleteQuery = () => { throw new Error('lost'); };
    f.timer.end();
    f.timer.begin(true, 18);
    expect(f.timer.snapshot().status).toBe('context-lost');
    expect(f.timer.snapshot().pendingQueries).toBe(0);
    f.timer.dispose();
    const broken = fixture();
    broken.gl.getExtension = () => { throw new Error('driver'); };
    broken.timer.begin(true);
    expect(broken.timer.snapshot().status).toBe('error');
});


test('capture generation changes discard old results before they can enter the new report', () => {
    const f = fixture();
    f.timer.begin(true, 17, 1);
    f.timer.end();
    f.queries[0].available = true;
    f.timer.begin(true, 18, 2);
    f.timer.end();
    expect(f.samples).toEqual([]);
    expect(f.queries[0].deleted).toBe(true);
    expect(f.timer.snapshot().pendingQueries).toBe(1);
});
