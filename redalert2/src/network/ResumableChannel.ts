import type { WireData } from './server/ServerTransport';

export const RESUME_GRACE_MS = 30000;
export const RESUME_BUFFER_BYTES = 4 * 1024 * 1024;
export const RESUME_BUFFER_MESSAGES = 2048;
export const RESUME_MAX_PACKET_BYTES = 128 * 1024 + 5;

/** Exactly-once, ordered delivery across socket replacements. Both directions retain unacknowledged messages. */
export class ResumableChannel {
    received = 0;
    private sent = 0;
    private acknowledged = 0;
    private bytes = 0;
    private readonly pending = new Map<number, Uint8Array>();
    constructor(private readonly deliver: (data: WireData) => void) {}
    encode(data: WireData): Uint8Array {
        const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (payload.length + 5 > RESUME_MAX_PACKET_BYTES || this.bytes + payload.length + 5 > RESUME_BUFFER_BYTES || this.pending.size >= RESUME_BUFFER_MESSAGES || this.sent === 0xffffffff) throw new Error('Connection recovery buffer exceeded.');
        const packet = new Uint8Array(payload.length + 5);
        packet[0] = typeof data === 'string' ? 0 : 1;
        new DataView(packet.buffer).setUint32(1, ++this.sent, true);
        packet.set(payload, 5);
        this.pending.set(this.sent, packet); this.bytes += packet.length;
        return packet;
    }
    acknowledge(sequence: unknown): void {
        if (!Number.isSafeInteger(sequence) || (sequence as number) < this.acknowledged || (sequence as number) > this.sent) throw new Error('Invalid recovery acknowledgement.');
        this.acknowledged = sequence as number;
        for (const [id, packet] of this.pending) if (id <= this.acknowledged) { this.pending.delete(id); this.bytes -= packet.length; }
    }
    receive(packet: Uint8Array): void {
        if (packet.length < 5 || packet.length > RESUME_MAX_PACKET_BYTES || packet[0] > 1) throw new Error('Invalid recovery packet.');
        const sequence = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1, true);
        if (!sequence || sequence > this.received + 1) throw new Error('Recovery packet sequence gap.');
        if (sequence <= this.received) return;
        this.received = sequence;
        this.deliver(packet[0] === 0 ? new TextDecoder().decode(packet.subarray(5)) : packet.slice(5));
    }
    replay(): Uint8Array[] { return [...this.pending.values()]; }
}
