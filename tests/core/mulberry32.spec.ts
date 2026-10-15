import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@core/rng';

/**
 * The one mulberry32 gives, bit for bit, what the copies it replaced gave
 * (people, hair, plants, facades): the same seed, the same model.
 */
function copyAsItWas(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mulberry32', () => {
  it('draws the same sequence as the copies it replaced', () => {
    for (const seed of [0, 1, 42, 0x9e3779b9, -7, 2 ** 32 - 1, 123456789 * 7919]) {
      const a = mulberry32(seed), b = copyAsItWas(seed);
      for (let k = 0; k < 1000; k++) expect(a()).toBe(b());
    }
  });
});
