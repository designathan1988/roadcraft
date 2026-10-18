import { describe, expect, it } from 'vitest';
import { doubles, indices } from '@render/mesh/stream';

/** A MESH'S NUMBERS UNDER CONSTRUCTION IN TYPED MEMORY (`mesh/stream.ts`) */
describe('a typed stream', () => {
  it('holds what was pushed, in order, exactly, however far it grew', () => {
    const xs = doubles(4), is = indices(4);
    const want: number[] = [], wantI: number[] = [];
    for (let k = 0; k < 1000; k++) {
      const v = Math.sin(k) * 1e5 + 1 / 3;
      if (k % 3 === 0) { xs.push3(v, -v, v / 7); want.push(v, -v, v / 7); } else if (k % 3 === 1) { xs.push2(v, v * 2); want.push(v, v * 2); } else { xs.push1(v); want.push(v); }
      is.push3(k, k + 1, k * 3); wantI.push(k, k + 1, k * 3);
    }
    // The doubles a number[] holds, bit for bit.
    expect(Array.from(xs.view())).toEqual(want);
    expect(Array.from(is.view())).toEqual(wantI);
    expect(xs.view().buffer).toBe(xs.data.buffer);
    xs.clear();
    expect(xs.view().length).toBe(0);
  });
});
