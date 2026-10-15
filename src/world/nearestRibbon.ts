import type { Vec2 } from '@core/vec2';
import type { Network, SegmentRibbon } from './network';
import { m } from './units';

/** The first box searched round a point, u; each search after it four times as wide. */
const FIRST_REACH = m(60);
/** Wider than any map: the last box holds every road. */
const LAST_REACH = m(200_000);

/** DO NOT walk every road of the map for the street nearest a point: every lot drawn did, for each of its sides. */
export function nearestRibbon(net: Network, p: Vec2): { readonly ribbon: SegmentRibbon; readonly distance: number } | null {
  if (!net.ribbons.size || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  for (let r = FIRST_REACH; ; r *= 4) {
    let best: { ribbon: SegmentRibbon; distance: number } | null = null;
    for (const ribbon of net.ribbonsMeeting([p.x - r, p.y - r, p.x + r, p.y + r])) {
      const distance = ribbon.full.distanceTo(p);
      if (!best || distance < best.distance) best = { ribbon, distance };
    }
    if ((best && best.distance <= r) || r >= LAST_REACH) return best;
  }
}
