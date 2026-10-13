import { describe, expect, it } from 'vitest';
import { natureNoise, natureDensity } from '@render/natureNoise';
import * as before from './_natureNoiseReference';

/**
 * THE WOODS' NOISE WITHOUT A CLOSURE A SAMPLE (`render/natureNoise.ts`): the
 * same numbers, to the bit, as when it made its hashes inside each call - so
 * not one tree moves.
 */
describe('the woods noise', () => {
  it('gives the very numbers it gave before', () => {
    let seed = 7;
    const next = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 4000; i++) {
      const x = (next() - 0.5) * 30000, y = (next() - 0.5) * 30000, s = 5 + next() * 300, salt = 1 + Math.floor(next() * 50);
      expect(natureNoise(x, y, s, salt)).toBe(before.natureNoise(x, y, s, salt));
      expect(natureDensity(x, y, 1, 0.3, 0.2)).toBe(before.natureDensity(x, y, 1, 0.3, 0.2));
    }
  });
});
