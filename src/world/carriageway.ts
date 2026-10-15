import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';

/** DO NOT go back to a grid of every road's centre line made again at each network revision */
export function onCarriageway(net: Network, p: Vec2): boolean {
  for (const id of net.segmentCells.idsMeeting([p.x, p.y, p.x, p.y])) {
    const ribbon = net.ribbons.get(id);
    const centre = ribbon?.centre[Level.Asphalt];
    if (!ribbon || !centre) continue;
    const half = halfWidth(ribbon.road, Level.Asphalt);
    const bb = centre.bbox;
    if (p.x < bb.minX - half || p.x > bb.maxX + half || p.y < bb.minY - half || p.y > bb.maxY + half) continue;
    if (centre.closestPoint(p).distance < half) return true;
  }
  return false;
}
