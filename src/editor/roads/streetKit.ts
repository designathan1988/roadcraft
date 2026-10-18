import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { PoleId, SegmentId } from '@world/ids';
import type { LandscapeKind } from '@world/landscape';
import { FURNITURE_CATALOG } from '@world/roads/furnitureCatalog';
import { type FurnitureSet, furnitureFor } from '@world/roads/furnitureSets';
import { m } from '@world/units';
import type { Vec2 } from '@core/vec2';
import { layPowerLines } from './powerLine';

/** A STREET'S POWER LINE AND FURNITURE CARRIED THROUGH AN EDIT OF ITS ROAD: widened, narrowed or moved, the road takes them along instead of leaving them in its lanes or the grass */

/** The pieces a street is furnished with (`furnitureSets.ts`): what an edit carries; a sign or a name plate stays where it was put. */
const CARRIED: ReadonlySet<LandscapeKind> = new Set(FURNITURE_CATALOG.map((e) => e.kind));
/** Past the outer edge of the footway, what still belongs to the street (a pole or a tree pit at its edge). */
const BEYOND = m(1.5);
/** Inside the kerb, what still counts as the footway's (a lamp leaning on the kerb face). */
const WITHIN = m(1);

/** What stood on the streets before the edit: their poles and pieces, and the set to lay again. */
interface Kit {
  readonly poles: PoleId[];
  readonly items: number[];
  readonly line: boolean;
}

/** The street nearest to `p` among `net`'s, and how far and where along it `p` is. */
function nearestStreet(net: Network, p: Vec2): { id: SegmentId; distance: number; s: number; length: number } | null {
  let best: { id: SegmentId; distance: number; s: number; length: number } | null = null;
  const r = m(40);
  for (const id of net.segmentCells.idsMeeting([p.x - r, p.y - r, p.x + r, p.y + r])) {
    const line = net.ribbons.get(id)?.full;
    if (!line) continue;
    const hit = line.closestPoint(p);
    if (!best || hit.distance < best.distance) best = { id, distance: hit.distance, s: hit.s, length: line.length };
  }
  return best;
}

/** The poles and pieces standing on `segments`' footways, each street's own (nearer to it than to any other). */
function kitOf(doc: RoadDoc, net: Network, segments: readonly SegmentId[]): Kit {
  const mine = new Set(segments);
  const poles: PoleId[] = [], items: number[] = [];
  const owned = (p: Vec2): boolean => {
    const near = nearestStreet(net, p);
    if (!near || !mine.has(near.id)) return false;
    const road = net.ribbons.get(near.id)!.road;
    return near.s > 0 && near.s < near.length && near.distance >= road.width / 2 - WITHIN && near.distance <= road.width / 2 + road.sidewalk + BEYOND;
  };
  for (const id of segments) {
    const box = net.ribbons.get(id)?.full.bbox;
    if (!box) continue;
    const pad = m(30);
    const rect = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad] as const;
    for (const pole of doc.polesIn(rect)) if (!poles.includes(pole.id) && owned(pole)) poles.push(pole.id);
    for (const item of doc.landscapeIn(rect)) if (CARRIED.has(item.kind) && !items.includes(item.id) && owned(item)) items.push(item.id);
  }
  return { poles, items, line: poles.length > 0 };
}

/** Runs a road edit of `segments` (`edit`, true when it changed the map), then lays their power line and furniture again on the roads it left (`after`: their ids then, the same by default) */
export function carryStreetKit(doc: RoadDoc, net: Network, segments: readonly SegmentId[], edit: () => boolean,
  after: () => readonly SegmentId[] = () => segments.filter((id) => doc.segment(id) !== undefined)): boolean {
  if (net.revision !== doc.revision) net.rebuild();
  const kit = kitOf(doc, net, segments);
  if (!edit()) return false;
  if (!kit.poles.length && !kit.items.length) return true;
  for (const id of kit.poles) doc.removePole(id);
  for (const id of kit.items) doc.removeLandscape(id);
  if (net.revision !== doc.revision) net.rebuild();
  const streets = after();
  const power = kit.line && layPowerLines(doc, net, streets) > 0;
  // The complete set came with the line; pieces alone were the basic set.
  const set: FurnitureSet = kit.line ? 'complete' : 'basic';
  if (kit.items.length) for (const piece of furnitureFor(net, streets, set, null, power)) doc.addLandscape(piece.kind, piece.at);
  return true;
}
