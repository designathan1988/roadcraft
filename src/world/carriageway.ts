import type { Vec2 } from '@core/vec2';
import { identityMemo } from '@core/identityMemo';
import { pointInPolygon } from '@core/polygon';
import type { Ring } from '@core/ring';
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

/** A junction's footway ring as points, once per ring (a junction solved again is a new one). */
const ringPoints = identityMemo((ring: Ring): readonly Vec2[] => ring.flatten());

/** Whether the point is on a street's ground: its carriageway, its footways, or a junction's plate (a tunnel's road is under the ground, not on it).
 * What the ecosystem's trees and woods stand off: DO NOT test them by `onCarriageway` alone, a road laid through a wood left the trees on its footways and its junctions (the player, 2026-10-23). */
export function onRoadGround(net: Network, p: Vec2): boolean {
  // Each filing's one cell read, as `onCarriageway`.
  return net.segmentCells.someAt(p.x, p.y, (id) => {
    const ribbon = net.ribbons.get(id);
    if (!ribbon || net.doc.segment(id)?.structure === 'tunnel') return false;
    const half = halfWidth(ribbon.road, Level.Sidewalk);
    const bb = ribbon.full.bbox;
    if (p.x < bb.minX - half || p.x > bb.maxX + half || p.y < bb.minY - half || p.y > bb.maxY + half) return false;
    return ribbon.full.closestPoint(p).distance < half;
  }) || net.junctionCells.someAt(p.x, p.y, (node) => {
    const ring = net.junctions.get(node)?.get(Level.Sidewalk)?.ring;
    if (!ring || ring.isEmpty) return false;
    const bb = ring.bbox;
    if (p.x < bb.minX || p.x > bb.maxX || p.y < bb.minY || p.y > bb.maxY) return false;
    return pointInPolygon(p, ringPoints(ring));
  });
}
