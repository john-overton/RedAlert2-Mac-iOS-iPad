import {expect,test} from 'bun:test';
import {MatchArchive} from './MatchArchive';
test('archive only exposes contiguous agreed frames, ordered batches and deterministic drops',()=>{
 const a=new MatchArchive();a.order(1,2,new Uint8Array([1]));a.order(1,1,new Uint8Array());a.drop({frame:2,clientId:2,takeover:'ai'});
 a.agree(2,22,'2');expect(a.liveFrame).toBe(0);a.agree(1,11,'0');expect(a.liveFrame).toBe(2);
 expect(a.read(1)[0].orders.map(o=>o.clientId)).toEqual([1,2]);expect(a.read(2)[0].drops[0].takeover).toBe('ai');
});
test('archive caps chunks and bounds pending bytes as well as committed history',()=>{
 const a=new MatchArchive();for(let frame=1;frame<=40;frame++){a.order(frame,1,new Uint8Array(3000));a.agree(frame,frame,'0');}
 const frames=a.read(1);expect(frames.length).toBeLessThanOrEqual(32);expect(JSON.stringify(frames).length).toBeLessThan(65536);
 const pending=new MatchArchive(100);pending.order(100,1,new Uint8Array(100));expect(pending.available).toBe(false);
 const limit=new MatchArchive(10000,2);limit.order(3,1,new Uint8Array());expect(limit.available).toBe(false);
});

test('archive exhaustion stops encoding payloads, including the first over-budget order', () => {
    const archive = new MatchArchive(64);
    const cannotIterate = { length: 100, [Symbol.iterator]() { throw new Error('Payload must not be encoded'); } } as unknown as Uint8Array;
    expect(() => archive.order(1, 1, cannotIterate)).not.toThrow();
    expect(archive.available).toBe(false);
    const cannotRead = new Proxy(new Uint8Array(), { get() { throw new Error('Disabled archive must not inspect payload'); } });
    expect(() => archive.order(2, 1, cannotRead)).not.toThrow();
});

test('archive reads reject malformed cursors and oversized offsets without scanning', () => {
    const archive = new MatchArchive(); archive.order(1, 1, new Uint8Array()); archive.agree(1, 1, '0');
    for (const cursor of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(archive.read(cursor)).toEqual([]);
    expect(archive.read(1, 0)).toEqual([]); expect(archive.read(1, Infinity)).toEqual([]);
});
