import { describe, expect, it } from 'vitest';
import { askPlate } from '@render/groundShape';

describe('a plate asked of the ground worker', () => {
  it('takes an empty box (Infinity bounds) or a NaN region as no corners', () => {
    const n = 5;
    const grid = { n, x: (i: number) => i % n, y: (i: number) => Math.floor(i / n) } as never;
    const natural = new Float64Array(n * n);
    const ask = askPlate(grid, natural, [[Infinity, -Infinity, Infinity, -Infinity], [NaN, 2, 0, 1], [1, 2, 1, 2]]);
    expect(ask.natural.length).toBe(4);
    expect(ask.xy.length).toBe(8);
  });
});
