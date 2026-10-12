import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '@core/polygon';
import { RegionIndex } from '@core/regionIndex';
import type { Vec2 } from '@core/vec2';

/** A deterministic stream in [0, 1). */
function stream(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

describe('region index', () => {
  const square: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole: Vec2[] = [{ x: 3, y: 3 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 3 }];
  const star: Vec2[] = Array.from({ length: 14 }, (_, i) => {
    const r = i % 2 ? 4 : 9;
    const a = (i / 14) * Math.PI * 2;
    return { x: 20 + Math.cos(a) * r, y: 5 + Math.sin(a) * r };
  });

  it('agrees with a ray cast over every ring, holes included', () => {
    const index = RegionIndex.fromRings([square, hole, star], 'evenodd', 2);
    const next = stream(7);
    for (let i = 0; i < 5000; i++) {
      const p = { x: -5 + next() * 40, y: -8 + next() * 26 };
      let inside = false;
      for (const ring of [square, hole, star]) if (pointInPolygon(p, ring)) inside = !inside;
      expect(index.contains(p.x, p.y)).toBe(inside);
    }
  });

  it('unions overlapping rings with the nonzero rule, whichever way they wind', () => {
    const a: Vec2[] = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }];
    const b: Vec2[] = [{ x: 4, y: 4 }, { x: 4, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 4 }];
    const index = RegionIndex.fromRings([a, b], 'nonzero', 3);
    expect(index.contains(5, 5)).toBe(true);
    expect(index.contains(1, 1)).toBe(true);
    expect(index.contains(9, 9)).toBe(true);
    expect(index.contains(9, 1)).toBe(false);
  });

  it('measures the run of a line inside and outside the region', () => {
    const index = RegionIndex.fromRings([square], 'nonzero', 4);
    const run = { lo: 0, hi: 0 };
    expect(index.run(2, 5, 1, 0, 50, run)).toBe(true);
    expect(run.lo).toBeCloseTo(-2, 9);
    expect(run.hi).toBeCloseTo(8, 9);
    expect(index.run(15, 5, 1, 0, 3, run)).toBe(false);
    expect(run.lo).toBeCloseTo(-3, 9);
    expect(run.hi).toBeCloseTo(3, 9);
    expect(index.span(15, 5, 1, 0, 3, run)).toBe(false);
    expect(index.boundaryDistance(2, 5, 5)).toBeCloseTo(2, 9);
    expect(index.boundaryDistance(50, 50, 5)).toBe(Infinity);
  });

  it('files rings kilometres apart in small grids of their own, answering as one grid would', () => {
    // As the planet keeps each piece's rings on its own chart, far apart in
    // the atlas: one dense grid over all of them was millions of empty cells
    // (the player's map, 3.3 million a grid, 2026-10-11).
    const at = (ring: Vec2[], dx: number, dy: number): Vec2[] => ring.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const rings = [square, hole, star, at(square, 9000, 0), at(star, 9000, 40), at(square, -3000, 7000), at(hole, -3000, 7000),
      // And one just past the gap from the first: its own cluster, near enough for a line or a distance to reach both.
      at(square, 0, 10 + 4 * 2 + 2.5)];
    for (const rule of ['evenodd', 'nonzero'] as const) {
      const index = RegionIndex.fromRings(rings, rule, 2);
      expect(index.clusterCount).toBeGreaterThan(2);
      expect(index.cellCount).toBeLessThan(5000);
      const next = stream(11);
      const centres = [[15, 10], [9010, 20], [-2995, 7005]] as const;
      for (let i = 0; i < 6000; i++) {
        const [cx, cy] = centres[i % 3]!;
        const p = { x: cx - 25 + next() * 50, y: cy - 20 + next() * 40 };
        let crossings = 0, winding = 0;
        for (const ring of rings) {
          if (!pointInPolygon(p, ring)) continue;
          crossings++;
          // Every ring here is simple: inside it, it winds the point once, its own way round.
          let area = 0;
          for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) area += (ring[b]!.x - ring[a]!.x) * (ring[b]!.y + ring[a]!.y);
          winding += rule === 'nonzero' ? 1 : (area < 0 ? -1 : 1);
        }
        const inside = rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
        expect(index.contains(p.x, p.y)).toBe(inside);
        // The nearest edge, by brute force over every ring.
        let best = Infinity;
        for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const A = ring[b]!, B = ring[a]!, dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
          const t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / l2));
          best = Math.min(best, Math.hypot(p.x - A.x - dx * t, p.y - A.y - dy * t));
        }
        const d = index.boundaryDistance(p.x, p.y, 12);
        if (best <= 12) expect(d).toBeCloseTo(best, 9); else expect(d).toBe(Infinity);
      }
    }
    // A line from one cluster across the gap into the next meets the far one's edge.
    const index = RegionIndex.fromRings(rings, 'evenodd', 2);
    const run = { lo: 0, hi: 0 };
    expect(index.run(5, 15, 0, 1, 30, run)).toBe(false);
    expect(run.lo).toBeCloseTo(-5, 9);
    expect(run.hi).toBeCloseTo(20.5 - 15, 9);
  });
});
