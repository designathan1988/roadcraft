import { describe, expect, it, vi } from 'vitest';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY, type CityStyle, type CitySize } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { WalkGraph, buildWalkways, type Walkway } from '@world/walkways';

/**
 * A CROSSING LANDS WHERE IT LANDED (2026-10-14): `landOn` stopped measuring
 * every walkway of the town for each crossing end (`WalkGraph.nearestOwn`:
 * the footways filed by road, the corners by node). At every call, as the
 * graph stands then - splits and all - the walkway, the point and the
 * distance must be exactly the old scan's, the earliest winning a tie.
 * The old scan is kept frozen below.
 */

function referenceNearest(g: WalkGraph, p: Vec2, seg: SegmentId, node: NodeId): { way: Walkway; s: number; distance: number } | null {
  let best: { way: Walkway; s: number; distance: number } | null = null;
  for (const way of g.ways) {
    const mine = (way.kind === 'footway' && way.segment === seg) || (way.kind === 'corner' && way.node === node);
    if (!mine) continue;
    const c = way.path.closestPoint(p);
    if (!best || c.distance < best.distance) best = { way, s: c.s, distance: c.distance };
  }
  return best;
}

const TOWNS: [number, CitySize, CityStyle][] = [
  [1, 'small', 'blocks'], [2, 'small', 'grid'], [3, 'small', 'organic'], [4, 'small', 'radial'], [5, 'small', 'mixed'],
  [6, 'medium', 'organic'],
];

describe('walkway landing: the filed lists give what the scan gave', () => {
  for (const [seed, size, style] of TOWNS) {
    it(`every crossing end of a ${size} ${style} town (seed ${seed})`, () => {
      const real = WalkGraph.prototype.nearestOwn;
      let calls = 0, differing = 0;
      const spy = vi.spyOn(WalkGraph.prototype, 'nearestOwn').mockImplementation(function (this: WalkGraph, p, seg, node) {
        const got = real.call(this, p, seg, node);
        const want = referenceNearest(this, p, seg, node);
        calls++;
        if (got?.way !== want?.way || !Object.is(got?.s, want?.s) || !Object.is(got?.distance, want?.distance)) differing++;
        return got;
      });
      try {
        const net = new Network(layCity(planCity({ ...DEFAULT_CITY, seed, size, style })));
        net.rebuild();
        const g = buildWalkways(net);
        expect(g.ways.some((w) => w.kind === 'crossing' && !w.unmarked)).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBeGreaterThan(300);
      expect(differing).toBe(0);
    });
  }
});
