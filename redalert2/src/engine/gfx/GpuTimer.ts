/** Asynchronous WebGL2 elapsed queries. Results are polled only on later frames.
 * https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
 */
interface TimerExtension {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
}
interface PendingQuery {
    query: WebGLQuery;
    tick?: number;
    startedAt: number;
}
export type GpuTimerStatus = 'disabled' | 'unsupported' | 'active' | 'disjoint' | 'context-lost' | 'error';
export const MAX_PENDING_GPU_QUERIES = 8;

export class GpuTimer {
    private extension?: TimerExtension | null;
    private pending: PendingQuery[] = [];
    private active?: PendingQuery;
    private status: GpuTimerStatus = 'disabled';
    private droppedQueries = 0;
    private lost = false;
    private generation?: number;

    constructor(private gl: WebGL2RenderingContext,
        private record: (milliseconds: number, tick: number | undefined, startedAt: number) => void) {}

    snapshot() {
        return {
            status: this.status,
            pendingQueries: this.pending.length + Number(!!this.active),
            maxPendingQueries: MAX_PENDING_GPU_QUERIES,
            droppedQueries: this.droppedQueries,
        };
    }

    begin(enabled: boolean, tick?: number, generation = 0): void {
        if (this.lost) return;
        try {
            if (this.generation !== generation) {
                this.clear();
                this.generation = generation;
                this.droppedQueries = 0;
            }
            if (!enabled) {
                this.clear();
                this.status = 'disabled';
                return;
            }
            if (this.status === 'error') return;
            if (this.extension === undefined) {
                this.extension = typeof this.gl.createQuery === 'function'
                    ? this.gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
            }
            if (!this.extension) {
                this.status = 'unsupported';
                return;
            }
            // A disjoint event invalidates every outstanding measurement.
            if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
                this.droppedQueries += this.pending.length + Number(!!this.active);
                this.clear();
                this.status = 'disjoint';
                return;
            }
            this.status = 'active';
            this.poll();
            if (this.active || this.pending.length >= MAX_PENDING_GPU_QUERIES ||
                this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) {
                this.droppedQueries++;
                return;
            }
            const query = this.gl.createQuery();
            if (!query) {
                this.droppedQueries++;
                return;
            }
            this.active = { query, tick, startedAt: performance.now() };
            this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
        } catch {
            this.fail();
        }
    }

    end(): void {
        if (!this.active || !this.extension || this.lost) return;
        try {
            this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
            this.pending.push(this.active);
            this.active = undefined;
        } catch {
            this.fail();
        }
    }

    private poll(): void {
        // At most eight availability checks; never request an unavailable result.
        while (this.pending.length) {
            const sample = this.pending[0];
            if (!this.gl.getQueryParameter(sample.query, this.gl.QUERY_RESULT_AVAILABLE)) break;
            const nanoseconds = this.gl.getQueryParameter(sample.query, this.gl.QUERY_RESULT);
            this.gl.deleteQuery(sample.query);
            this.pending.shift();
            if (typeof nanoseconds === 'number' && Number.isFinite(nanoseconds) && nanoseconds >= 0) {
                this.record(nanoseconds / 1_000_000, sample.tick, sample.startedAt);
            }
        }
    }

    private clear(): void {
        if (this.active && this.extension) {
            this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
            this.gl.deleteQuery(this.active.query);
        }
        this.active = undefined;
        for (const sample of this.pending) this.gl.deleteQuery(sample.query);
        this.pending.length = 0;
    }

    private fail(): void {
        try { this.clear(); } catch { /* Diagnostics must not break rendering. */ }
        this.active = undefined;
        this.pending.length = 0;
        this.status = 'error';
    }

    contextLost(): void {
        // Lost-context queries have already been invalidated by WebGL.
        this.lost = true;
        this.pending.length = 0;
        this.active = undefined;
        this.status = 'context-lost';
    }

    dispose(): void {
        if (!this.lost) {
            try { this.clear(); } catch { /* Context may have been lost before its event. */ }
        }
        this.pending.length = 0;
        this.active = undefined;
        this.status = 'disabled';
    }
}
