import type { Network, SegmentRibbon } from '../network';
import { CASING_BAND, FOOTWAY_RISE, flushOn, footwayOn } from '../roadTypes';

/**
 * How high the footway stands over the carriageway at a point (docs/VIAS.md
 * V1, "the kerb is where the heights differ"): `FOOTWAY_RISE` on a kerbed
 * footway, nothing on one laid flush with the carriageway (a shared
 * surface, OpenDRIVE's lane `height` of zero). One answer for everything
 * that stands on a footway - its mesh, the people, the lamps, the signs, the
 * poles - so none of them floats over a flush footway or sinks into a
 * kerbed one.
 *
 * Cheap where there is nothing flush, which is every map before V1: the
 * flush roads are listed once per network revision and the answer is the
 * constant when there are none.
 */
interface FlushIndex {
  readonly revision: number;
  readonly roads: readonly { readonly ribbon: SegmentRibbon; readonly left: boolean; readonly right: boolean; readonly reach: number }[];
}

const indexes = new WeakMap<Network, FlushIndex>();

function flushIndex(net: Network): FlushIndex {
  const known = indexes.get(net);
  if (known && known.revision === net.revision) return known;
  const roads: FlushIndex['roads'][number][] = [];
  for (const ribbon of net.ribbons.values()) {
    const left = flushOn(ribbon.road, 'left'), right = flushOn(ribbon.road, 'right');
    if (!left && !right) continue;
    roads.push({ ribbon, left, right, reach: ribbon.road.width / 2 + ribbon.road.sidewalk + CASING_BAND });
  }
  const index = { revision: net.revision, roads };
  indexes.set(net, index);
  return index;
}

const hit = { s: 0, distance: 0 };

/** The share of `FOOTWAY_RISE` the footway at (x, y) stands at: 1 kerbed, 0 flush. */
export function footwayRiseShare(net: Network, x: number, y: number): number {
  const { roads } = flushIndex(net);
  if (!roads.length) return 1;
  for (const road of roads) {
    const box = road.ribbon.full.bbox;
    if (x < box.minX - road.reach || x > box.maxX + road.reach || y < box.minY - road.reach || y > box.maxY + road.reach) continue;
    road.ribbon.full.closestInto(x, y, hit);
    if (hit.distance > road.reach) continue;
    const frame = road.ribbon.full.sampleAt(hit.s);
    const left = (x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y >= 0;
    if (!(left ? road.left : road.right)) continue;
    const edge = road.ribbon.road.width / 2;
    if (hit.distance >= edge - 1e-6 && hit.distance <= edge + footwayOn(road.ribbon.road, left ? 'left' : 'right') + CASING_BAND) return 0;
  }
  return 1;
}

/** The footway's height over the carriageway at (x, y), world units. */
export const footwayRiseAt = (net: Network, x: number, y: number): number => FOOTWAY_RISE * footwayRiseShare(net, x, y);
