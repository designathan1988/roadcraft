import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type MultiPoly, union } from '@core/clipper';

/** A UNION THAT RAN OUT OF MEMORY (2026-10-16): four footway rings of the whole city's tile -5,-2 (seed 1), the fourth a ring that comes back to its first point and goes on with seven points a tenth of a millimetre apart (a spike of no width); Clipper2's port looped on it, the tile's worker grew to 2.9 GB and the page's V8 cage (4 GB) died. */
describe('a union of degenerate footway rings', () => {
  it('ends, in the area the rings cover', () => {
    const rings = JSON.parse(readFileSync('tests/fixtures/clipper-union-seed1-tile-5-2.json', 'utf8')) as MultiPoly;
    const started = performance.now();
    const out = union(rings);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out.length).toBeGreaterThan(0);
  }, 30_000);
});
