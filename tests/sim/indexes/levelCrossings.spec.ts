import { describe, expect, it } from 'vitest';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import type { SimWorld } from '@sim/world';
import { levelCrossings } from '@sim/transit/transit';
import { seededEdit, seededWorld } from './support';

/**
 * A train's level crossings, each leg of its loop meeting only the lanes near
 * it (`levelCrossings`, the lanes' grid), are the old loop's over every lane
 * of the map, segment by segment, against every leg (the oracle below): the
 * same crossings in the same order. Through road edits, on loops drawn at
 * random across the town and along its roads (legs ending on a lane's points).
 */
function oldCrossings(w: SimWorld, points: readonly Vec2[], at: readonly number[]) {
  const crossAt = (a: Vec2, b: Vec2, p: Vec2, q: Vec2): { u: number; v: number } | null => {
    const rx = b.x - a.x, ry = b.y - a.y, sx = q.x - p.x, sy = q.y - p.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return null;
    const u = ((p.x - a.x) * sy - (p.y - a.y) * sx) / den;
    const v = ((p.x - a.x) * ry - (p.y - a.y) * rx) / den;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
  };
  const crossings: { lanelet: string; at: number; loopS: number }[] = [];
  for (const lane of w.graph.lanelets.values()) {
    const c = lane.centre;
    for (let j = 1; j < c.n; j++) {
      const p = c.point(j - 1), q = c.point(j);
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        const hit = crossAt(a, b, p, q);
        if (!hit) continue;
        const laneS = c.closestPoint({ x: p.x + (q.x - p.x) * hit.v, y: p.y + (q.y - p.y) * hit.v }).s;
        crossings.push({ lanelet: lane.id, at: laneS, loopS: at[i]! + Math.hypot(b.x - a.x, b.y - a.y) * hit.u });
      }
    }
  }
  return crossings;
}

function loop(w: SimWorld, rng: Rng): { points: Vec2[]; at: number[] } {
  const points: Vec2[] = [];
  const n = rng.int(2, 12);
  const lanes = [...w.graph.lanelets.values()];
  for (let i = 0; i < n; i++) {
    if (rng.bool(0.3)) {
      // On a lane's own point: a leg ending exactly on a lane.
      const c = lanes[rng.int(0, lanes.length - 1)]!.centre;
      points.push(c.point(rng.int(0, c.n - 1)));
    } else points.push({ x: m(rng.range(-380, 380)), y: m(rng.range(-380, 380)) });
  }
  const at = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return { points, at };
}

describe('level crossings found by the lanes near each leg', () => {
  for (const seed of [5, 0xc0ffee]) {
    it(`are the old loop's, in its order (seed ${seed}), through edits`, () => {
      const w = seededWorld(seed);
      const rng = new Rng(seed + 1);
      let found = 0;
      for (let edit = 0; edit < 4; edit++) {
        for (let k = 0; k < 12; k++) {
          const { points, at } = loop(w, rng);
          const now = levelCrossings(w, points, at);
          expect(now).toEqual(oldCrossings(w, points, at));
          found += now.length;
        }
        seededEdit(w, rng);
      }
      expect(found).toBeGreaterThan(50);
    });
  }
});
