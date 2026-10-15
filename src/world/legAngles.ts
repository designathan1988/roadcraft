import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { NodeId } from './ids';
import type { PolylineCache } from './geometry';

/** How sharply two roads may meet at one node. */
export const MIN_LEG_ANGLE = (25 * Math.PI) / 180;

/** Outgoing directions of a node's legs, in radians, sorted. */
export function legAngles(doc: RoadDoc, cache: PolylineCache, node: NodeId): number[] {
  const source = doc.node(node);
  if (!source) return [];

  const out: number[] = [];
  for (const segId of source.incident) {
    const segment = doc.segment(segId);
    if (!segment) continue;
    const points = cache.get(doc, segId).toPoints();
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

/** Smallest angle between any two of these legs, in radians. */
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

