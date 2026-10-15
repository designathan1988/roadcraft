import type { Network } from '../network';
import { CASING_BAND, FOOTWAY_RISE, flushOn, footwayOn } from '../roadTypes';

/**
 * How high the footway stands over the carriageway at a point (docs/source/VIAS.md
 * V1, "the kerb is where the heights differ"): `FOOTWAY_RISE` on a kerbed
 * footway, nothing on one laid flush with the carriageway (a shared
 * surface, OpenDRIVE's lane `height` of zero). One answer for everything
 * that stands on a footway - its mesh, the people, the lamps, the signs, the
 * poles - so none of them floats over a flush footway or sinks into a
 * kerbed one.
 *
 * Asked for every walker in every frame, and for every lamp, sign and pole:
 * the flush roads are found by place (`Network.flushCells`, kept by the
 * network's build), so a point reads the cells round it and nothing where
 * no road is flush - every map before V1.
 * DO NOT go back to a list of every flush road of the map, made again at
 * each network revision and walked for every point.
 */

const hit = { s: 0, distance: 0 };

/** The share of `FOOTWAY_RISE` the footway at (x, y) stands at: 1 kerbed, 0 flush. */
export function footwayRiseShare(net: Network, x: number, y: number): number {
  // A ribbon's filed bounds reach its casing (`ribbonBounds`): every road whose footway holds the point.
  for (const id of net.flushCells.idsMeeting([x, y, x, y])) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) continue;
    const reach = ribbon.road.width / 2 + ribbon.road.sidewalk + CASING_BAND;
    ribbon.full.closestInto(x, y, hit);
    if (hit.distance > reach) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const left = (x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y >= 0;
    if (!flushOn(ribbon.road, left ? 'left' : 'right')) continue;
    const edge = ribbon.road.width / 2;
    if (hit.distance >= edge - 1e-6 && hit.distance <= edge + footwayOn(ribbon.road, left ? 'left' : 'right') + CASING_BAND) return 0;
  }
  return 1;
}

/** The footway's height over the carriageway at (x, y), world units. */
export const footwayRiseAt = (net: Network, x: number, y: number): number => FOOTWAY_RISE * footwayRiseShare(net, x, y);
