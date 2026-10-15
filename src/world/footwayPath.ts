import { Polyline } from '@core/polyline';
import { offsetPolyline } from '@core/offset';
import type { Vec2 } from '@core/vec2';
import type { ChangeRect } from './changes';
import type { SegmentId } from './ids';
import { Level, type RoadType, type SegmentDirection } from './roadTypes';
import { bandMid, sectionOf } from './section';
import { m } from './units';

/** DO NOT import `network.ts` or `doc.ts` here */
export interface FootwayRibbon {
  readonly id: SegmentId;
  readonly road: RoadType;
  readonly centre: Record<number, Polyline>;
}
export interface FootwayNet {
  readonly doc: { segment(id: SegmentId): { readonly direction: SegmentDirection } | undefined };
  ribbonsMeeting(rect: ChangeRect): Iterable<FootwayRibbon>;
}

/** One side's footway of a road, as the walking network lays it: down the middle of that side's through zone, along a to b */
export function footwayPath(ribbon: FootwayRibbon, direction: SegmentDirection, side: 1 | -1): Polyline | null {
  const section = sectionOf(ribbon.road, direction);
  if (!section.walkable) return null;
  const centre = ribbon.centre[Level.Sidewalk];
  if (!centre || centre.n < 2 || centre.length < 1e-6) return null;
  // `offsetPolyline` offsets to the LEFT for a positive distance.
  return Polyline.fromPoints(offsetPolyline(centre.toPoints(), side * bandMid((side > 0 ? section.left : section.right).through)));
}

/** How far apart a footway is sampled when its nearest point is turned down, world units. */
const REJECT_STEP = m(1);

/** DO NOT build the walking network of the whole map to find the footway at one point. */
export function nearestFootway(net: FootwayNet, p: Vec2, reach: number, rejects?: (point: Vec2) => boolean): { x: number; y: number; segment: SegmentId; d: number } | null {
  let best: { x: number; y: number; segment: SegmentId; d: number } | null = null;
  for (const ribbon of net.ribbonsMeeting([p.x - reach, p.y - reach, p.x + reach, p.y + reach])) {
    const segment = net.doc.segment(ribbon.id);
    if (!segment) continue;
    for (const side of [1, -1] as const) {
      const path = footwayPath(ribbon, segment.direction, side);
      if (!path) continue;
      const hit = path.closestPoint(p);
      if (!(hit.distance < reach) || (best && hit.distance >= best.d)) continue;
      let point = hit.point, d = hit.distance;
      if (rejects?.(point)) {
        // The nearest point of this footway that is not turned down, a metre apart along it
        let found: { point: Vec2; d: number } | null = null;
        for (let s = 0, end = path.length; s <= end; s += REJECT_STEP) {
          const q = path.sampleAt(Math.min(s, end)).p;
          const dq = Math.hypot(q.x - p.x, q.y - p.y);
          if (dq < reach && (!found || dq < found.d) && !rejects(q)) found = { point: { x: q.x, y: q.y }, d: dq };
        }
        if (!found || (best && found.d >= best.d)) continue;
        ({ point, d } = found);
      }
      best = { x: point.x, y: point.y, segment: ribbon.id, d };
    }
  }
  return best;
}
