import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';

/**
 * The default generated city is laid in rectangular blocks (the player,
 * 2026-10-09: "quarteirões certos, retangulares"): every street straight and
 * axis-aligned, every block the same rectangle, nothing curved or wedged.
 */
describe('city in rectangular blocks', () => {
  for (const size of ['small', 'medium', 'large'] as const) {
    it(`${size}: straight, axis-aligned streets on a regular grid`, () => {
      const plan = planCity({ ...DEFAULT_CITY, size, seed: 11 });
      expect(plan.options.style).toBe('blocks');
      const { nodes, edges } = plan.graph;
      expect(edges.length).toBeGreaterThan(20);
      const xs = new Set(nodes.map((p) => Math.round(p.x * 100)));
      const ys = new Set(nodes.map((p) => Math.round(p.y * 100)));
      // A full grid: every column meets every row.
      expect(nodes.length).toBe(xs.size * ys.size);
      const lengths = new Set<number>();
      for (const e of edges) {
        expect(e.points.length).toBe(0);
        const a = nodes[e.a]!, b = nodes[e.b]!;
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        expect(Math.min(dx, dy)).toBeLessThan(1e-6);
        lengths.add(Math.round(Math.max(dx, dy) * 100));
      }
      // Two block sides only: long and short.
      expect(lengths.size).toBe(2);
      // Avenues, collectors and local streets all present.
      expect(new Set(edges.map((e) => e.level))).toEqual(new Set([0, 1, 2]));
    });
  }
});
