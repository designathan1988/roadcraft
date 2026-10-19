import { describe, expect, it, vi } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { ringDistance } from '@world/buildings/pads';
import { type LotSlope, lotHeightAt } from '@world/buildings/lots';
import { buildingFrame, frameToLocal } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';

/** A POINT'S DISTANCE TO A PLATFORM'S RING (`pads.ts` `ringDistance`): the edges compared by their squares, the same answer to the bit */

/** The distance as it was: `Math.hypot` of every edge. */
function before(ring: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return inside ? 0 : best;
}

/** A small seeded random, so a failure repeats. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
}

describe('a ring distance', () => {
  it('is the least hypot of its edges, to the bit, ties and all', () => {
    const rnd = random(5);
    const rings: Vec2[][] = [];
    for (let r = 0; r < 300; r++) {
      const cx = rnd() * 400 - 200, cy = rnd() * 400 - 200, n = 3 + Math.floor(rnd() * 12);
      // Some turned, some square to the axes on whole metres (the grid's corners stand at equal distances from two edges).
      const square = r % 3 === 0;
      rings.push(Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + (square ? 0 : rnd() * 0.3);
        const d = square ? 10 + (r % 7) : 5 + rnd() * 30;
        return square ? { x: Math.round(cx + d * Math.sign(Math.cos(a))), y: Math.round(cy + d * Math.sign(Math.sin(a))) } : { x: cx + d * Math.cos(a), y: cy + d * Math.sin(a) };
      }));
    }
    for (const ring of rings) {
      for (let k = 0; k < 60; k++) {
        const x = k % 2 ? Math.round(ring[0]!.x + rnd() * 80 - 40) : ring[0]!.x + rnd() * 80 - 40;
        const y = k % 2 ? Math.round(ring[0]!.y + rnd() * 80 - 40) : ring[0]!.y + rnd() * 80 - 40;
        expect(Object.is(ringDistance(ring, x, y), before(ring, x, y)), `${x}, ${y}`).toBe(true);
      }
    }
  });

  it('takes the root of only the edges that can be the nearest', () => {
    const ring = Array.from({ length: 64 }, (_, i) => ({ x: 50 * Math.cos((i / 64) * Math.PI * 2), y: 30 * Math.sin((i / 64) * Math.PI * 2) }));
    const hypot = vi.spyOn(Math, 'hypot');
    for (let k = 0; k < 100; k++) ringDistance(ring, 80 + k, 10 - k * 0.5);
    // Not one a edge (6,400): a few a point.
    expect(hypot.mock.calls.length).toBeLessThan(100 * 64 / 4);
    hypot.mockRestore();
  });

  it('reads the height of a lot with its frame inline, the same numbers', () => {
    const rnd = random(9);
    /** The height as it was: the point made by `frameToLocal`. */
    const was = (s: Exclude<LotSlope, { kind: 'level' }>, x: number, y: number): number => {
      const p = frameToLocal(s.frame, x, y);
      const c = (t: number): number => Math.max(0, Math.min(1, t));
      if (s.kind === 'ramp') return s.from + (s.level - s.from) * Math.max(0, Math.min(1, (p.y - s.y0) / s.d));
      const u = c((p.x - s.x0) / s.w), w = c((p.y - s.y0) / s.d);
      switch (s.side) {
        case 0: return (s.ha + (s.hb - s.ha) * u) * (1 - w) + s.floor * w;
        case 2: return (s.ha + (s.hb - s.ha) * u) * w + s.floor * (1 - w);
        case 1: return (s.ha + (s.hb - s.ha) * w) * u + s.floor * (1 - u);
        default: return (s.ha + (s.hb - s.ha) * w) * (1 - u) + s.floor * u;
      }
    };
    for (let k = 0; k < 2000; k++) {
      const frame = buildingFrame({ x: rnd() * 200, y: rnd() * 200, rotation: rnd() * 7 } as Building);
      const s: Exclude<LotSlope, { kind: 'level' }> = k % 5 === 0
        ? { kind: 'ramp', frame, from: rnd() * 3, level: rnd() * 3, y0: rnd() * 5, d: 1 + rnd() * 20 }
        : { kind: 'street', frame, side: k % 4, x0: rnd() * 5, y0: rnd() * 5, w: 1 + rnd() * 30, d: 1 + rnd() * 30, ha: rnd() * 2, hb: rnd() * 2, floor: rnd() * 2 };
      const x = rnd() * 260 - 30, y = rnd() * 260 - 30;
      expect(Object.is(lotHeightAt(s, x, y), was(s, x, y))).toBe(true);
    }
  });
});
