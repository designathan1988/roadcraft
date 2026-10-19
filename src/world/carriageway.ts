import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';

/** DO NOT go back to a grid of every road's centre line made again at each network revision */
export function onCarriageway(net: Network, p: Vec2): boolean {
  // The point's one cell read, no set, list nor sort made (VEG-07: asked for every tree, stone and planted tree): whether any road holds it, as `idsMeeting` over the point.
  return net.segmentCells.someAt(p.x, p.y, (id) => {
    const ribbon = net.ribbons.get(id);
    const centre = ribbon?.centre[Level.Asphalt];
    if (!ribbon || !centre) return false;
    const half = halfWidth(ribbon.road, Level.Asphalt);
    const bb = centre.bbox;
    if (p.x < bb.minX - half || p.x > bb.maxX + half || p.y < bb.minY - half || p.y > bb.maxY + half) return false;
    return centre.closestPoint(p).distance < half;
  });
}
