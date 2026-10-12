import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { NodeId } from './ids';
import { PolylineCache, nodeChart } from './geometry';

/**
 * How sharply two roads may meet at one node.
 *
 * Below this angle `acuteSetback` — the distance at which two carriageways stop
 * overlapping — grows without bound, the trim goes from about 30 units to about
 * 185, and `legTongue` paints a finger of kerb and footway that long across
 * open grass with no asphalt beside it. Measured by a probe script since removed:
 * a 7-degree hairpin gives trims of 246 and a tongue 16.6 times the road's
 * half-width, against 2.0 for a healthy cross or T.
 *
 * Drawing and dragging used to refuse an edit that made a node sharper than
 * this (a differential check, so an old hairpin elsewhere did not block every
 * road); that refusal went with the freeform roads (e77538b7). The map's
 * offenders are found and reported (`Network`, `impossibleNodes`).
 */
export const MIN_LEG_ANGLE = (25 * Math.PI) / 180;

/**
 * Outgoing directions of a node's legs, in radians, sorted.
 *
 * Taken from each segment's own polyline one flattened step in from the node —
 * its TANGENT there — not from the straight line to the far node. On a tight
 * curve those disagree by tens of degrees, and the junction builder uses the
 * tangent, so measuring anything else would condemn nodes that build correctly
 * and pass nodes that do not.
 */
export function legAngles(doc: RoadDoc, cache: PolylineCache, node: NodeId): number[] {
  const source = doc.node(node);
  if (!source) return [];

  const out: number[] = [];
  for (const segId of source.incident) {
    const segment = doc.segment(segId);
    if (!segment) continue;
    const points = cache.at(doc, segId, nodeChart(doc, node)).toPoints();
    if (points.length < 2) continue;
    const startsHere = segment.a === node;
    const at = (startsHere ? points[0] : points[points.length - 1]) as Vec2;
    const next = (startsHere ? points[1] : points[points.length - 2]) as Vec2;
    const dx = next.x - at.x;
    const dy = next.y - at.y;
    if (dx === 0 && dy === 0) continue;
    out.push(Math.atan2(dy, dx));
  }
  out.sort((p, q) => p - q);
  return out;
}

/**
 * Smallest angle between any two of these legs, in radians.
 *
 * `Infinity` for a node with fewer than two legs: a stub cannot be too sharp.
 * The angles must arrive sorted, which `legAngles` guarantees.
 */
export function smallestGap(angles: readonly number[]): number {
  if (angles.length < 2) return Infinity;
  let worst = Infinity;
  for (let i = 0; i < angles.length; i++) {
    let gap = (angles[(i + 1) % angles.length] as number) - (angles[i] as number);
    // The last pair wraps past the branch cut of `atan2`.
    if (i === angles.length - 1) gap += Math.PI * 2;
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * Every node that cannot be built, with the gap that condemns it.
 *
 * This is the sweep a LOAD uses. Loading must never refuse — refusing to open a
 * map destroys the user's work — so the map comes in whole and the offenders
 * are reported instead.
 */
export function impossibleNodes(doc: RoadDoc, cache = new PolylineCache()): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  for (const node of doc.nodes.keys()) {
    const gap = smallestGap(legAngles(doc, cache, node));
    if (gap < MIN_LEG_ANGLE) out.set(node, gap);
  }
  return out;
}
