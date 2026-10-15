import { describe, expect, it } from 'vitest';
import type { Polyline } from '@core/polyline';
import { SimWorld } from '@sim/world';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { BODY_ENVELOPE, HEAVY } from '@world/conflictPoints';
import { CROSSWALK_DEPTH } from '@world/approach';
import { m } from '@world/units';

/** THE ZEBRA SPANS MEASURED ONLY WHERE A MOVEMENT COMES NEAR (`crossingSpans.ts` `measure`) */
const REACH = (BODY_ENVELOPE[HEAVY]?.width ?? 0) / 2 + m(0.9);
function oracle(path: Polyline, crossing: Polyline, length: number): { s0: number; s1: number; along: number } | null {
  let s0 = Infinity, s1 = -Infinity, centre = Infinity;
  for (let s = 0; s <= length; s += 0.5) {
    const hit = path.closestPoint(crossing.sampleAt(s).p);
    if (hit.distance > REACH) continue;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    centre = Math.min(centre, hit.s);
  }
  const along = Math.max(0, centre - CROSSWALK_DEPTH / 2 - m(0.6));
  return s0 <= s1 ? { s0, s1, along } : null;
}

describe('the zebra spans', () => {
  it('are what measuring every sample gives, on generated cities', () => {
    let crossed = 0;
    for (const seed of [3, 5]) {
      const doc = layCity(planCity({ ...DEFAULT_CITY, seed, size: 'small', radius: m(300) }));
      const net = new Network(doc);
      net.rebuild();
      const w = new SimWorld(doc, net, 7);
      w.rebuildTopology();
      for (const [node, junction] of w.graph.junctions) {
        const incident = doc.node(node)?.incident ?? [];
        const edgeOf = (segment: number) => w.sidewalks.edges.get(w.sidewalks.crossings.get(`${node}:${segment}`) ?? '');
        for (const id of junction.connectors) {
          const path = w.lanelet(id)!.centre;
          for (const segment of incident) {
            const edge = edgeOf(segment);
            if (!edge) continue;
            const want = oracle(path, edge.path, edge.length);
            if (want) crossed++;
            expect(w.crossingSpans.span(id, `${node}:${segment}`), `${id} over ${node}:${segment}`).toEqual(want);
          }
        }
        for (const laneId of junction.inbound) {
          const lane = w.lanelet(laneId);
          if (!lane || lane.kind !== 'link') continue;
          let stop = lane.length;
          for (const segment of incident) {
            const edge = segment === lane.segment ? undefined : edgeOf(segment);
            const span = edge ? oracle(lane.centre, edge.path, edge.length) : null;
            if (span) stop = Math.min(stop, span.along);
          }
            expect(w.crossingSpans.approachStop(laneId), laneId).toBe(stop < lane.length ? stop : undefined);
        }
      }
    }
    expect(crossed).toBeGreaterThan(100);
  });
});
