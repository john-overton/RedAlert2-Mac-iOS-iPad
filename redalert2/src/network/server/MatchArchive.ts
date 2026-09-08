import type { ObserverFrame } from './Protocol';

/** A bounded, append-only log. Exhaustion disables observation, never player simulation. */
export class MatchArchive {
    private pending = new Map<number, ObserverFrame>();
    private committed: ObserverFrame[] = [];
    private bytes = 0;
    available = true;
    constructor(private readonly maxBytes = 64 * 1024 * 1024, private readonly maxFrames = 100000) {}
    get liveFrame(): number { return this.committed.length; }
    private reserve(frame: number, bytes: number): ObserverFrame | undefined {
        if (!this.available) return;
        if (frame > this.maxFrames || this.bytes + bytes > this.maxBytes) { this.available = false; this.pending.clear(); this.committed = []; return; }
        this.bytes += bytes;
        let value = this.pending.get(frame);
        if (!value) { value = { frame, orders: [], drops: [], hash: 0, defeatMask: '0' }; this.pending.set(frame, value); }
        return value;
    }
    order(frame: number, clientId: number, actions: Uint8Array): void {
        if (!this.available) return;
        // Check the encoded size before allocating strings, including pending frames.
        const value = this.reserve(frame, Math.ceil(actions.length / 3) * 4 + 64);
        if (!value) return;
        let binary = ''; for (const byte of actions) binary += String.fromCharCode(byte);
        value.orders.push({ clientId, actions: btoa(binary) });
    }
    drop(drop: ObserverFrame['drops'][number]): void { this.reserve(drop.frame, 96)?.drops.push({ ...drop }); }
    agree(frame: number, hash: number, defeatMask: string): void {
        const value = this.reserve(frame, 128); if (!value) return;
        value.hash = hash; value.defeatMask = defeatMask;
        // Syncs become agreed sequentially; only expose a contiguous committed prefix.
        (value as ObserverFrame & { agreed?: boolean }).agreed = true;
        while ((this.pending.get(this.liveFrame + 1) as (ObserverFrame & { agreed?: boolean }) | undefined)?.agreed) {
            const next = this.pending.get(this.liveFrame + 1)!;
            this.pending.delete(next.frame); delete (next as ObserverFrame & { agreed?: boolean }).agreed;
            next.orders.sort((a,b) => a.clientId-b.clientId);
            this.committed.push(next);
        }
    }
    read(fromFrame: number, maxFrames = 32): ObserverFrame[] {
        if (!this.available || !Number.isSafeInteger(fromFrame) || fromFrame < 1 || !Number.isSafeInteger(maxFrames) || maxFrames < 1) return [];
        const result: ObserverFrame[] = []; let bytes = 512;
        for (let i = fromFrame - 1; i < this.committed.length && result.length < Math.min(maxFrames,32); i++) {
            const frame = this.committed[i]; const size = JSON.stringify(frame).length;
            if (bytes + size > 64 * 1024) { if (!result.length) { this.available = false; this.pending.clear(); this.committed = []; } break; }
            result.push(frame); bytes += size;
        }
        return result;
    }
}
