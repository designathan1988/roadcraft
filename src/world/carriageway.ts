import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';

/**
 * Whether a point is on the carriageway of a road of the network (kerb to kerb).
 *
 * The roads near the point are read from the network's own cells
 * (`Network.segmentCells`, kept by its build): a ribbon is filed over its
 * casing, which reaches past its carriageway. The plants, the stones and the
 * planted trees ask this for tens of thousands of points.
 * DO NOT go back to a grid of every road's centre line made again at each
 * network revision: every edit paid for the whole map at the next question.
 */
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
