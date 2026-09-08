import { expect, test } from 'bun:test';
import { ResumableChannel, RESUME_BUFFER_MESSAGES } from './ResumableChannel';

test('lost acknowledgements replay each text/binary payload exactly once and preserve order', () => {
    const delivered: unknown[] = [];
    const sender = new ResumableChannel(() => {});
    const receiver = new ResumableChannel(value => delivered.push(value));
    const text = sender.encode('orders');
    const binary = sender.encode(new Uint8Array([1, 2, 3]));
    receiver.receive(text);
    for (const packet of sender.replay()) receiver.receive(packet);
    expect(delivered).toEqual(['orders', new Uint8Array([1, 2, 3])]);
    sender.acknowledge(receiver.received);
    expect(sender.replay()).toEqual([]);
    receiver.receive(binary);
    expect(delivered).toHaveLength(2);
});
test('recovery rejects gaps, future/rollback acknowledgements, and bounded queue exhaustion', () => {
    const channel = new ResumableChannel(() => {});
    channel.encode('first'); const second = channel.encode('second');
    expect(() => channel.receive(second)).toThrow('gap');
    expect(() => channel.acknowledge(3)).toThrow('acknowledgement');
    channel.acknowledge(1);
    expect(() => channel.acknowledge(0)).toThrow('acknowledgement');
    for (let i = 1; i < RESUME_BUFFER_MESSAGES; i++) channel.encode('x');
    expect(() => channel.encode('overflow')).toThrow('buffer');
});
