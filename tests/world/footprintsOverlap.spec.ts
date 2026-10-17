import { describe, expect, it } from 'vitest';
import clipping from 'polygon-clipping';
import type { Vec2 } from '@core/vec2';
import { overlapArea, supportShare, supportedBy } from '@world/buildings/footprints';

/** TWO CONVEX RINGS SHARE THE AREA THE GENERAL CLIPPER FINDS (`footprints.ts` `convexOverlap`, Sutherland and Hodgman) */

/** The area the sweep finds: what `overlapArea` gave before its convex path. */
function swept(a: readonly Vec2[], b: readonly Vec2[]): number {
  const poly = clipping.intersection([a.map((p) => [p.x, p.y])], [b.map((p) => [p.x, p.y])]);
  let total = 0;
  for (const rings of poly) rings.forEach((ring, k) => {
    let twice = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
    total += (k === 0 ? 1 : -1) * Math.abs(twice) / 2;
  });
  return total;
}

/** A turned rectangle, either way round. */
function rect(cx: number, cy: number, w: number, d: number, turn: number, clockwise = false): Vec2[] {
  const c = Math.cos(turn), s = Math.sin(turn);
  const ring = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => ({ x: cx + x! * c - y! * s, y: cy + x! * s + y! * c }));
  return clockwise ? ring.reverse() : ring;
}

describe('the area two footprints share', () => {
  it('is the sweep\'s for convex rings, turned, either winding, touching, apart or inside', () => {
    let seed = 7;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    let overlapping = 0;
    for (let k = 0; k < 3000; k++) {
      const a = rect(rnd() * 40, rnd() * 40, 2 + rnd() * 20, 2 + rnd() * 20, k % 3 === 0 ? 0 : rnd() * 3, k % 2 === 0);
      const b = rect(rnd() * 40, rnd() * 40, 2 + rnd() * 20, 2 + rnd() * 20, k % 5 === 0 ? 0 : rnd() * 3, k % 3 === 0);
      const want = swept(a, b), got = overlapArea(a, b);
      expect(Math.abs(got - want), `pair ${k}`).toBeLessThan(1e-9 * Math.max(1, want));
      if (want > 0) overlapping++;
    }
    expect(overlapping).toBeGreaterThan(500);
    // Side by side on one line: touching, nothing shared.
    expect(overlapArea(rect(0, 0, 10, 10, 0), rect(10, 0, 10, 10, 0))).toBe(0);
  });

  it('gives the share of a part over its supports as the sweep does, overlapping supports too', () => {
    const part = rect(5, 5, 8, 6, 0.3);
    const left = rect(2, 5, 6, 12, 0), right = rect(8, 5, 6, 12, 0);
    // Apart: summed; overlapping (a tower on its base): swept.
    for (const supports of [[left, rect(11, 5, 6, 12, 0)], [left, right], [rect(5, 5, 20, 20, 0)]]) {
      const area = 48;
      const rest = clipping.difference([part.map((p) => [p.x, p.y])], ...supports.map((s) => [s.map((p) => [p.x, p.y])]));
      let left2 = 0;
      for (const rings of rest) rings.forEach((ring, k) => {
        let twice = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
        left2 += (k === 0 ? 1 : -1) * Math.abs(twice) / 2;
      });
      expect(supportShare(part, supports)).toBeCloseTo(Math.max(0, 1 - left2 / area), 9);
      expect(supportedBy(part, supports)).toBe(left2 < 1e-5);
    }
  });
});
