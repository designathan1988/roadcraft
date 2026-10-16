import { describe, expect, it } from 'vitest';
import { packRecord, unpackRecord } from '@render/people/cookPack';

describe('a cooked record', () => {
  it('comes back as it went in: numbers, text, lists, flags, nulls and typed arrays', () => {
    const record = {
      name: 'hair:braid', colour: 0xffffff, loop: true, scaleRefs: [5399, 11998, 791], fade: null,
      refs: Uint32Array.from([1, 2, 3, 4294967295]), weights: Float32Array.from([0.25, 0.5, 0.25]),
      odd: Uint8Array.from([7, 8, 9]), faceList: Int32Array.from([-1, 0, 2047]), exact: Float64Array.from([Math.PI]),
    };
    const back = unpackRecord(packRecord(record));
    expect(back).toEqual(record);
    expect(back['weights']).toBeInstanceOf(Float32Array);
    expect(back['refs']).toBeInstanceOf(Uint32Array);
  });

  it('owns its arrays: none is a view that keeps the whole file alive', () => {
    const file = packRecord({ a: new Float32Array(1000), b: Uint8Array.from([1, 2, 3]) });
    const back = unpackRecord(file);
    const a = back['a'] as Float32Array, b = back['b'] as Uint8Array;
    expect(a.buffer).not.toBe(file);
    expect(a.buffer.byteLength).toBe(a.byteLength);
    expect(b.buffer.byteLength).toBe(3);
    expect(a.buffer).not.toBe(b.buffer);
  });
});
