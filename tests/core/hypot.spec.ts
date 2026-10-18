import { describe, expect, it } from 'vitest';
import { hypot2, hypot3 } from '@core/hypot';

/** `hypot2` AND `hypot3` ARE `Math.hypot`, BIT FOR BIT (`core/hypot.ts`) */

describe('hypot2', () => {
  it('is Math.hypot of two numbers to the bit: the edge cases', () => {
    const special = [0, -0, 1, -1, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, 1e300, -1e300, 1e-300, Number.MAX_VALUE, 3, 4, 1e-160, 1e160, 0.1, 0.2];
    for (const a of special) for (const b of special) expect(Object.is(hypot2(a, b), Math.hypot(a, b)), `${a} ${b}`).toBe(true);
  });

  it('is Math.hypot of two numbers to the bit: two million pairs at every scale the game reads and past it', () => {
    // A seeded stream (xorshift), so a failure is the same every run.
    let s = 0x9e3779b9 | 0;
    const next = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4_294_967_296; };
    let wrong = 0;
    for (let i = 0; i < 2_000_000; i++) {
      // Lengths of millimetres to tens of kilometres (the map's), and from 1e-12 to 1e12 now and then; either sign.
      const scale = i % 7 === 0 ? 10 ** (next() * 24 - 12) : 10 ** (next() * 7 - 3);
      const a = (next() - 0.5) * 2 * scale, b = (next() - 0.5) * 2 * (i % 3 === 0 ? scale * next() : scale);
      if (!Object.is(hypot2(a, b), Math.hypot(a, b))) wrong++;
    }
    expect(wrong).toBe(0);
  });
});

describe('hypot3', () => {
  it('is Math.hypot of three numbers to the bit: the edge cases', () => {
    const special = [0, -0, 1, -1, Infinity, -Infinity, NaN, Number.MIN_VALUE, 1e300, -1e300, 1e-300, Number.MAX_VALUE, 3, 4, 1e-160, 1e160, 0.1];
    for (const a of special) for (const b of special) for (const c of special) expect(Object.is(hypot3(a, b, c), Math.hypot(a, b, c)), `${a} ${b} ${c}`).toBe(true);
  });

  it('is Math.hypot of three numbers to the bit: two million triples, unit normals among them', () => {
    let s = 0x2545f491 | 0;
    const next = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4_294_967_296; };
    let wrong = 0;
    for (let i = 0; i < 2_000_000; i++) {
      const scale = i % 5 === 0 ? 1 : i % 7 === 0 ? 10 ** (next() * 24 - 12) : 10 ** (next() * 7 - 3);
      const a = (next() - 0.5) * 2 * scale, b = (next() - 0.5) * 2 * scale, c = i % 4 === 0 ? 0 : (next() - 0.5) * 2 * (i % 3 === 0 ? scale * next() : scale);
      if (!Object.is(hypot3(a, b, c), Math.hypot(a, b, c))) wrong++;
    }
    expect(wrong).toBe(0);
  });
});
