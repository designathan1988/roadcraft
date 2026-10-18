import type { Vec2 } from '@core/vec2';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { m } from '@world/units';

/** THE CONGESTION MAP (Layers > Congestion): each road in view coloured by how full its lanes are, green free, red jammed */

/** A vehicle as the map reads it: the road its lane is on (undefined on a junction's connector or off the road). */
interface Moving { readonly segment: SegmentId | undefined }

/** Road a queued car takes up, its length and the gap to the next, m (HCM jam density: some 130 cars a lane-km). */
const CAR_SPACE = m(7.5);
/** Free, busy, slowing, jammed: share of the lanes' length taken at each colour's start. */
const STOPS: readonly (readonly [number, string])[] = [[0, '#57d06b'], [0.25, '#f3c33b'], [0.45, '#f07a2b'], [0.65, '#e5372f']];

/** The colour of a road whose lanes are `occupancy` full. */
export function congestionColour(occupancy: number): string {
  let colour = STOPS[0]![1];
  for (const [from, c] of STOPS) if (occupancy >= from) colour = c;
  return colour;
}

/** Each road's occupancy: the length its vehicles take over the length of its travel lanes (a few cars waiting at a light leave a long street free). */
export function roadOccupancy(net: Network, vehicles: Iterable<Moving>): Map<SegmentId, number> {
  const count = new Map<SegmentId, number>();
  for (const car of vehicles) if (car.segment !== undefined) count.set(car.segment, (count.get(car.segment) ?? 0) + 1);
  const out = new Map<SegmentId, number>();
  for (const [id, n] of count) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) continue;
    const lanes = Math.max(1, ribbon.road.lanes) * Math.max(1, ribbon.full.length);
    out.set(id, Math.min(1, (n * CAR_SPACE) / lanes));
  }
  return out;
}

/** The congestion map drawn on the editor's overlay: the roads meeting `view` (a world box), as bands as wide as their carriageway. */
export function drawCongestion(ctx: CanvasRenderingContext2D, net: Network, vehicles: Iterable<Moving>,
  view: readonly [number, number, number, number], at: (p: Vec2) => Vec2): void {
  const occupancy = roadOccupancy(net, vehicles);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ribbon of net.ribbonsMeeting(view)) {
    const line = ribbon.full;
    const steps = Math.max(2, Math.min(48, Math.ceil(line.length / 12)));
    const mid = line.sampleAt(line.length / 2);
    const a = at(mid.p), b = at({ x: mid.p.x + mid.n.x * ribbon.road.width, y: mid.p.y + mid.n.y * ribbon.road.width });
    const width = Math.max(3, Math.hypot(b.x - a.x, b.y - a.y) * 0.7);
    ctx.strokeStyle = congestionColour(occupancy.get(ribbon.id) ?? 0);
    ctx.lineWidth = width;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    for (let k = 0; k <= steps; k++) {
      const p = at(line.sampleAt((k / steps) * line.length).p);
      if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
