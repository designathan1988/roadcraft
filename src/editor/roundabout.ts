import { shapeFromControl } from '@core/bezier';
import type { Vec2 } from '@core/vec2';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { casingHalf, ROAD_TYPES, roadProfile } from '@world/roadTypes';
import { m } from '@world/units';

const ROUNDABOUT_MIN_RADIUS = m(32);
const ROUNDABOUT_MAX_RADIUS = m(128);
const ROUNDABOUT_APPROACH_LENGTH = m(40);

export type RoundaboutResult =
  | { readonly committed: true; readonly ring: readonly SegmentId[]; readonly entrances: readonly SegmentId[] }
  | { readonly committed: false; readonly reason: 'size' | 'bounds' | 'occupied' | 'geometry' };

/** Why a roundabout of `radius` round `centre` cannot be placed, or null when it can: what the click would answer, asked before it (the preview). */
export function roundaboutRefusal(doc: RoadDoc, net: Network, centre: Vec2, radius: number, type = 0): Exclude<RoundaboutResult, { committed: true }>['reason'] | null {
  if (!Number.isFinite(radius) || radius < ROUNDABOUT_MIN_RADIUS || radius > ROUNDABOUT_MAX_RADIUS ||
    !Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isInteger(type) || !ROAD_TYPES[type]) return 'size';
  const reach = radius + ROUNDABOUT_APPROACH_LENGTH;
  // The ring and its four approaches inside the map (`wholeMap.ts` MAP_HALF).
  if (Math.abs(centre.x) + reach > MAP_HALF || Math.abs(centre.y) + reach > MAP_HALF) return 'bounds';
  // Refuse instead of silently burying existing roads or leaving unconnected geometric crossings.
  const width = casingHalf(roadProfile(type, 2, 'both'));
  // DO NOT measure every road of the map for one placement.
  const near = reach + width;
  for (const ribbon of net.ribbonsMeeting([centre.x - near, centre.y - near, centre.x + near, centre.y + near])) {
    const segment = doc.segment(ribbon.id);
    if (!segment) continue;
    const otherWidth = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking));
    if (net.polylines.get(doc, segment.id).distanceTo(centre) < reach + width + otherWidth) return 'occupied';
  }
  return null;
}

/** Places a single-lane roundabout on vacant ground. */
export function commitRoundabout(
  doc: RoadDoc,
  net: Network,
  centre: Vec2,
  radius = m(40),
  type = 0,
): RoundaboutResult {
  const refused = roundaboutRefusal(doc, net, centre, radius, type);
  if (refused) return { committed: false, reason: refused };

  const work = doc.fork();
  const nodes: NodeId[] = [];
  const ring: SegmentId[] = [];
  const entrances: SegmentId[] = [];
  const step = Math.PI / 4;
  const point = (angle: number, distance: number): Vec2 => ({
    x: centre.x + Math.cos(angle) * distance,
    y: centre.y + Math.sin(angle) * distance,
  });
  for (let i = 0; i < 8; i++) {
    const node = work.addNode(point(i * step, radius), 0, i % 2 !== 0);
    nodes.push(node.id);
    // `yield` on a node would stop the circulating stream as well.
    if (i % 2 === 0) work.setNodeControl(node.id, 'priority');
  }
  for (let i = 0; i < 8; i++) {
    const a = work.requireNode(nodes[i]!);
    const b = work.requireNode(nodes[(i + 1) % 8]!);
    const control = point((i + 0.5) * step, radius / Math.cos(step / 2));
    const segment = work.addSegment(a.id, b.id, type, shapeFromControl(a, b, control),
      i * step * radius, 'aToB', 1);
    if (!segment) return { committed: false, reason: 'geometry' };
    ring.push(segment.id);
  }
  for (let i = 0; i < 8; i += 2) {
    const outer = work.addNode(point(i * step, radius + ROUNDABOUT_APPROACH_LENGTH));
    const segment = work.addSegment(outer.id, nodes[i]!, type, null, 0, 'both', 2);
    if (!segment) return { committed: false, reason: 'geometry' };
    entrances.push(segment.id);
  }
  const workNet = net.fork(work);
  workNet.rebuild();
  if (nodes.some((id) => workNet.impossible.has(id))) return { committed: false, reason: 'geometry' };
  doc.takeBack(work);
  net.takeBack(workNet);
  return { committed: true, ring, entrances };
}
