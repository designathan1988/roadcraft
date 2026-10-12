import { describe, expect, it } from 'vitest';
import { nearestThree } from '@people/hair/procedural';
import { Rng } from '@core/rng';

type V3 = [number, number, number];

/** The search it replaced: every anchor, the first of equal distances kept. */
function bruteForce(P: ArrayLike<number>, anchors: readonly number[], p: V3): [number, number][] {
  const best: [number, number][] = [[Infinity, 0], [Infinity, 0], [Infinity, 0]];
  for (const v of anchors) {
    const d = (P[v * 3]! - p[0]) ** 2 + (P[v * 3 + 1]! - p[1]) ** 2 + (P[v * 3 + 2]! - p[2]) ** 2;
    if (d < best[2]![0]) { best[2] = [d, v]; best.sort((x, y) => x[0] - y[0]); }
  }
  return best;
}

describe('hair pinning: nearest three head vertices', () => {
  it('finds exactly what the search over every anchor found, ties included', () => {
    const rng = new Rng(7);
    const rnd = (): number => rng.float();
    // A mirrored head (x and -x): points on the middle plane are equally far
    // from both sides, as on the MakeHuman head.
    const P: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const x = rnd() * 1.2, y = rnd() * 2.4 - 1.2, z = rnd() * 2 - 1;
      P.push(x, y, z, -x, y, z);
    }
    // Snapped to a lattice too, for exact equal distances off the middle.
    for (let i = 0; i < 300; i++) P.push(Math.round(rnd() * 8) / 8, Math.round(rnd() * 8) / 8, Math.round(rnd() * 8) / 8);
    const anchors = Array.from({ length: P.length / 3 }, (_, v) => v).filter((v) => v % 7 !== 3);
    const nearest = nearestThree(P, anchors);
    const points: V3[] = [];
    for (let i = 0; i < 3000; i++) points.push([(rnd() - 0.5) * 3, (rnd() - 0.5) * 4, (rnd() - 0.5) * 3]);
    for (let i = 0; i < 500; i++) points.push([0, (rnd() - 0.5) * 3, (rnd() - 0.5) * 2]);
    for (let i = 0; i < 300; i++) points.push([Math.round(rnd() * 8) / 8, Math.round(rnd() * 8) / 8, Math.round(rnd() * 8) / 8]);
    // Far outside the head: a long hairstyle's tips at the shoulders.
    for (let i = 0; i < 200; i++) points.push([(rnd() - 0.5) * 12, -4 - rnd() * 6, (rnd() - 0.5) * 12]);
    // Points that are not numbers (a braid's lobes have some): nearest to nothing, and the search ends.
    points.push([NaN, 0, 0], [0, NaN, 1], [Infinity, 0, 0], [0, 0, -Infinity]);
    for (const p of points) expect(nearest(p)).toEqual(bruteForce(P, anchors, p));
  });
});
