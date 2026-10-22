import { describe, expect, it } from 'vitest';
import { simplifyLine } from '@core/simplifyLine';

/** AN OPEN LINE'S POINTS THAT CARRY NO SHAPE TAKEN OUT (`core/simplifyLine.ts`) */

describe('a simplified line', () => {
  it('keeps only the ends of a straight run', () => {
    const run = Array.from({ length: 101 }, (_, i) => ({ x: i, y: 2 * i }));
    expect(simplifyLine(run, 0.001)).toEqual([run[0], run[100]]);
  });

  it('keeps the bend of a run that turns, and every dropped point stays within the tolerance', () => {
    const run = [...Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0 })), ...Array.from({ length: 10 }, (_, i) => ({ x: 10, y: i + 1 }))];
    expect(simplifyLine(run, 0.001)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    const arc = Array.from({ length: 50 }, (_, i) => ({ x: Math.cos(i / 49 * Math.PI / 2) * 30, y: Math.sin(i / 49 * Math.PI / 2) * 30 }));
    const kept = simplifyLine(arc, 0.05);
    expect(kept.length).toBeLessThan(arc.length);
    for (const p of arc) {
      let nearest = Infinity;
      for (let i = 1; i < kept.length; i++) {
        const a = kept[i - 1]!, b = kept[i]!;
        const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2));
        nearest = Math.min(nearest, Math.hypot(p.x - a.x - ex * t, p.y - a.y - ey * t));
      }
      expect(nearest).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
});
