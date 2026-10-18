import { describe, expect, it } from 'vitest';
import { least, most } from '@core/minMax';

/** `least` AND `most` ARE `Math.min` AND `Math.max` OF TWO NUMBERS, BIT FOR BIT (`core/minMax.ts`) */

describe('least and most', () => {
  it('are Math.min and Math.max to the bit: NaN, -0, infinities and every pair of them', () => {
    const special = [0, -0, 1, -1, 0.5, -0.5, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 1e-300, 3];
    for (const a of special) {
      for (const b of special) {
        expect(Object.is(least(a, b), Math.min(a, b)), `min ${a} ${b}`).toBe(true);
        expect(Object.is(most(a, b), Math.max(a, b)), `max ${a} ${b}`).toBe(true);
      }
    }
  });

  it('are Math.min and Math.max to the bit over a million pairs', () => {
    let s = 0x9e3779b9 | 0;
    const next = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4_294_967_296 - 0.5) * 1e4; };
    let wrong = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const a = i % 11 === 0 ? 0 : next(), b = i % 13 === 0 ? -0 : i % 17 === 0 ? a : next();
      if (!Object.is(least(a, b), Math.min(a, b)) || !Object.is(most(a, b), Math.max(a, b))) wrong++;
    }
    expect(wrong).toBe(0);
  });
});
