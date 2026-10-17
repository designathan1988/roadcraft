import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { segSeg } from '@core/intersect';
import { isSimple } from '@core/polygon';
import type { Vec2 } from '@core/vec2';

/** A POLYGON'S SELF-INTERSECTION TEST (`polygon.ts` isSimple): the boxes before `segSeg` give the answer every pair gave */

/** The test as it was: every pair of edges with `segSeg`. */
function everyPair(points: readonly Vec2[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a0 = points[i]!, a1 = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      if (segSeg(a0, a1, points[j]!, points[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

describe('isSimple', () => {
  it('answers as every pair of edges did, on rings of any shape, near-touching ones and the map\'s far coordinates included', () => {
    const rng = new Rng(7);
    let simple = 0, crossed = 0;
    for (let round = 0; round < 6000; round++) {
      const n = 3 + Math.floor(rng.float() * 40);
      const far = rng.float() < 0.5 ? (rng.float() - 0.5) * 20000 : 0;
      const points: Vec2[] = [];
      const kind = round % 4;
      for (let k = 0; k < n; k++) {
        if (kind === 0) {
          // A star: simple when the radii keep their order round the centre.
          const a = (k / n) * Math.PI * 2, r = 5 + rng.float() * 20;
          points.push({ x: far + Math.cos(a) * r, y: far + Math.sin(a) * r });
        } else if (kind === 1) {
          // Anywhere: mostly crossing.
          points.push({ x: far + rng.float() * 30, y: far + rng.float() * 30 });
        } else if (kind === 2) {
          // On a coarse grid: shared vertices, collinear and touching edges.
          points.push({ x: far + Math.floor(rng.float() * 4), y: far + Math.floor(rng.float() * 4) });
        } else {
          // A ring with a vertex pushed a hair onto or past another edge.
          const a = (k / n) * Math.PI * 2;
          const r = k === 2 ? 10 * (1 + (rng.float() - 0.5) * 1e-9) : 10;
          points.push({ x: far + Math.cos(a) * r + (k === 4 ? rng.float() * 1e-10 : 0), y: far + Math.sin(a) * r });
        }
      }
      const was = everyPair(points);
      expect(isSimple(points), JSON.stringify(points)).toBe(was);
      if (was) simple++; else crossed++;
    }
    // Both answers met many times.
    expect(simple).toBeGreaterThan(500);
    expect(crossed).toBeGreaterThan(500);
  });
});
