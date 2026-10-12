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
});
