import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { Network } from '@world/network';
import { buildWalkways } from './oracle/buildWalkways';
import { nearestFootway } from '@world/footwayPath';
import { type TransitData, emptyTransit, addStop, addTrack, stopNear, stopById, trackPointNear } from '@world/transit';
import { m } from '@world/units';

/**
 * The public transport tool's questions by place (`editor/transitTools.ts`)
 * answer what the walks over the whole map answered: the footway at a click
 * (the walking network of the whole map, every footway measured), the stop
 * at a click (every stop), the track point the pointer snaps to (every point
 * of every track), the stop by id (`stops.find`).
 */
describe('the transit tool by place', () => {
  it('finds the footway the whole walking network found', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small', seed: 3 }));
    const net = new Network(doc);
    net.rebuild();
    const ways = buildWalkways(net).walkways().filter((w) => w.kind === 'footway' && w.segment !== undefined);
    const old = (p: Vec2, reach: number, rejects?: (q: Vec2) => boolean) => {
      let best: { x: number; y: number; segment: number; d: number } | null = null;
      for (const way of ways) {
        const hit = way.path.closestPoint(p);
        if (rejects?.(hit.point)) continue;
        if (hit.distance < reach && (!best || hit.distance < best.d)) best = { x: hit.point.x, y: hit.point.y, segment: way.segment!, d: hit.distance };
      }
      return best;
    };
    const rng = new Rng(7);
    const span = m(600);
    let found = 0;
    for (let i = 0; i < 400; i++) {
      const p = { x: rng.range(-span, span), y: rng.range(-span, span) };
      const reach = i % 4 === 0 ? m(120) : m(18);
      // A rejection that depends on the point alone, as the buildings' test does.
      const rejects = i % 3 === 0 ? (q: Vec2) => Math.floor(q.x / m(7)) % 2 === 0 : undefined;
      const want = old(p, reach, rejects);
      const got = nearestFootway(net, p, reach, rejects);
      if (want) found++;
      if (rejects) {
        // Never a point turned down, within reach, and as near as the walk over
        // the footway's pieces found (to the metre the footway is sampled at).
        if (got) { expect(rejects(got), `point ${i}`).toBe(false); expect(got.d).toBeLessThan(reach); }
        if (want) { expect(got, `point ${i}`).not.toBeNull(); expect(got!.d, `point ${i}`).toBeLessThanOrEqual(want.d + m(1)); }
        continue;
      }
      // The same footway and the same point, to rounding (the same sum done in another order).
      expect(got === null, `point ${i}`).toBe(want === null);
      if (got && want) {
        expect(Number(got.segment), `point ${i}`).toBe(want.segment);
        expect(Math.hypot(got.x - want.x, got.y - want.y), `point ${i}`).toBeLessThan(1e-6);
        expect(Math.abs(got.d - want.d), `point ${i}`).toBeLessThan(1e-6);
      }
    }
    expect(found).toBeGreaterThan(50);
  });

  it('finds the stop, the track point and the stop by id that walking every one found', () => {
    const rng = new Rng(11);
    let data: TransitData = emptyTransit();
    for (let i = 0; i < 300; i++) {
      const mode = (['bus', 'train', 'metro'] as const)[i % 3]!;
      data = addStop(data, { mode, x: rng.range(-m(800), m(800)), y: rng.range(-m(800), m(800)) }).data;
    }
    for (let i = 0; i < 40; i++) {
      const points = Array.from({ length: 2 + (i % 5) }, () => ({ x: rng.range(-m(800), m(800)), y: rng.range(-m(800), m(800)) }));
      data = addTrack(data, i % 2 ? 'train' : 'metro', points).data;
    }
    for (let i = 0; i < 1000; i++) {
      const p = { x: rng.range(-m(850), m(850)), y: rng.range(-m(850), m(850)) };
      const mode = i % 4 === 0 ? undefined : (['bus', 'train', 'metro'] as const)[i % 3]!;
      const reach = m(4) + rng.range(0, m(60));
      let stop: number | null = null, bestD = reach;
      for (const s of data.stops) {
        if (mode && s.mode !== mode) continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) { bestD = d; stop = s.id; }
      }
      expect(stopNear(data, p, reach, mode)?.id ?? null).toBe(stop);
      const rail = i % 2 ? 'train' as const : 'metro' as const;
      let point: Vec2 | null = null;
      search: for (const t of data.tracks) {
        if (t.mode !== rail) continue;
        for (const q of t.points) if (Math.hypot(q.x - p.x, q.y - p.y) < reach) { point = q; break search; }
      }
      expect(trackPointNear(data, p, reach, rail)).toEqual(point);
    }
    for (const s of data.stops) expect(stopById(data, s.id)).toBe(s);
    expect(stopById(data, -1)).toBeUndefined();
  });
});
