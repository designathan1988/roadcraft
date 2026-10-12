import { normalizeAngle } from '@core/scalar';
import { Ring, arcEdge, lineEdge, type RingEdge } from '@core/ring';
import { type Vec2, add, angleOf, scale, sub } from '@core/vec2';
import type { RoadDoc } from '../doc';
import type { NodeId } from '../ids';
import type { PolylineCache } from '../geometry';
import type { Network } from '../network';
import { pointInPolygon } from '@core/polygon';
import { Level, type SurfaceLevel } from '../roadTypes';
import { m } from '../units';
import { buildLegs } from './legs';
import type { Junction } from './build';

/**
 * A TURNING CIRCLE AT A ROAD'S END (docs/VIAS.md V8, balão de retorno): the
 * player marks an end as one (`RoadNode.end`), and traffic turns round there
 * instead of leaving the map.
 *
 * The carriageway is a circle of `BULB_RADIUS` round the end: fire codes ask
 * 13-15 m (Chico, CA: a 48 ft outside radius; Hebron, OH: a 44 ft pavement
 * radius), and smaller bulbs of 10-14 m serve houses (Center for Watershed
 * Protection). Cars and vans turn round in it; a bus or a lorry fits it alone,
 * but one following another round at the closest gap would stand in it, so
 * the turn is not offered to them (`turnPaths.ts` sweep). Every outer surface - kerb,
 * footway, verge - is that circle carried out by its own width, as the
 * levels of a road are, so the painter stacks them as it stacks a junction's.
 * The road's ribbon stops where its edge meets the circle; the circle covers
 * the rest of it.
 */
export const BULB_RADIUS = m(13);
/**
 * The radius traffic turns round it at: a body on this line keeps inside the
 * circle and its kerb returns, a 12 m bus included (measured).
 */
export const BULB_TURN_RADIUS = BULB_RADIUS - m(3);

/**
 * The kerb's return from the road's edge into the circle (Silverton, OR:
 * a 25 ft curb radius at a bulb's transition): without it the edge met the
 * circle in a notch a car keeping right swept out of.
 */
export const BULB_RETURN = m(7.5);

/** A bulb's outline at some lateral reach, in its leg's frame at the node. */
interface Outline { readonly ring: Ring; readonly mouth: number }

/**
 * The outline `grow` outside the carriageway's (a kerb, a footway, a walking
 * line), whose road edges stand `hwL` and `hwR` off the centreline: the
 * circle grown by `grow` and its kerb returns shrunk by it, so every outline
 * runs parallel to the carriageway's. `mouth` is where the returns begin.
 */
function outline(c: Vec2, dir: Vec2, nrm: Vec2, hwL: number, hwR: number, grow: number): Outline | null {
  const r = BULB_RADIUS + grow;
  const rf = Math.max(m(0.5), BULB_RETURN - grow);
  if (r <= Math.max(hwL, hwR) + m(0.5)) return null;
  // Each return's centre: a return's radius off the road's edge, and off the circle.
  const along = (hw: number): number => Math.sqrt(Math.max(0, (r + rf) ** 2 - (hw + rf) ** 2));
  const xL = along(hwL), xR = along(hwR);
  const d = Math.max(xL, xR);
  const at = (x: number, y: number): Vec2 => add(add(c, scale(dir, x)), scale(nrm, y));
  const mouthL = at(d, hwL), mouthR = at(d, -hwR);
  const edgeL = at(xL, hwL), edgeR = at(xR, -hwR);
  const fL = at(xL, hwL + rf), fR = at(xR, -(hwR + rf));
  const touch = (f: Vec2): Vec2 => add(c, scale(sub(f, c), r / (r + rf)));
  const tL = touch(fL), tR = touch(fR);
  // The long way round, through the side away from the road.
  const a0 = angleOf(sub(tL, c)), a1 = angleOf(sub(tR, c));
  const back = angleOf(scale(dir, -1));
  let sweep = normalizeAngle(a1 - a0);
  if (sweep < 0) sweep += Math.PI * 2;
  let behind = normalizeAngle(back - a0);
  if (behind < 0) behind += Math.PI * 2;
  const ccw = behind < sweep;
  const round: RingEdge = { kind: 'arc', c, r, a0, a1: ccw ? a0 + sweep : a0 - (Math.PI * 2 - sweep), ccw, to: tR };
  const edges: RingEdge[] = [lineEdge(mouthL)];
  if (Math.hypot(edgeL.x - mouthL.x, edgeL.y - mouthL.y) > 1e-6) edges.push(lineEdge(edgeL));
  edges.push(arcEdge(fL, rf, edgeL, tL), round, arcEdge(fR, rf, tR, edgeR));
  if (Math.hypot(edgeR.x - mouthR.x, edgeR.y - mouthR.y) > 1e-6) edges.push(lineEdge(mouthR));
  return { ring: new Ring(mouthR, edges), mouth: d };
}

/** The circle's outline at one level from its node, the leg cut where its kerb returns begin. */
export function buildBulb(doc: RoadDoc, cache: PolylineCache, nodeId: NodeId, level: SurfaceLevel): Junction | null {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 1 || node.end !== 'bulb') return null;
  const asphalt = buildLegs(doc, cache, nodeId, Level.Asphalt)[0];
  const here = buildLegs(doc, cache, nodeId, level)[0];
  if (!asphalt || !here) return null;
  const c: Vec2 = { x: node.x, y: node.y };
  const shape = outline(c, here.dir, here.nrm, here.hwLeft, here.hwRight, Math.max(0, here.hw - asphalt.hw));
  // A road shorter than the circle and its returns has no end to round off.
  if (!shape || here.length < shape.mouth + m(2)) return null;
  const d = shape.mouth;
  const leg = buildLegs(doc, cache, nodeId, level, { trims: new Map([[here.seg, d]]) })[0]!;
  const ring = shape.ring.ensurePositive();
  const at = (x: number, y: number): Vec2 => add(add(c, scale(leg.dir, x)), scale(leg.nrm, y));
  const tongue = new Ring(at(0, -leg.hwRight), [lineEdge(at(d, -leg.hwRight)), lineEdge(at(d, leg.hwLeft)), lineEdge(at(0, leg.hwLeft)),
    lineEdge(at(0, -leg.hwRight))]).ensurePositive();
  return {
    nodeId, level, legs: [leg], corners: [], trims: [d], ring, tongues: [tongue], rings: [ring],
    usedHullFallback: false, transition: false,
  };
}

/**
 * A line round a bulb `offset` from its road's centreline on both sides (a
 * footway's walking line), from its left end round the far side to its
 * right: the walk that joins a cul-de-sac's two footways.
 */
export function bulbLine(doc: RoadDoc, cache: PolylineCache, nodeId: NodeId, offset: number): Vec2[] | null {
  const node = doc.node(nodeId);
  if (!node || node.incident.length !== 1 || node.end !== 'bulb') return null;
  const asphalt = buildLegs(doc, cache, nodeId, Level.Asphalt)[0];
  if (!asphalt) return null;
  const shape = outline({ x: node.x, y: node.y }, asphalt.dir, asphalt.nrm, offset, offset, Math.max(0, offset - asphalt.hw));
  if (!shape) return null;
  // The ring runs right mouth, left mouth, round, back to the right: drop the mouth's line.
  const flat = shape.ring.flatten();
  return [...flat.slice(1), flat[0]!];
}

/**
 * Whatever stands in a turning circle's carriageway is taken away - a pole,
 * a tree, a bench set on the footway of a road's end before it was made a
 * circle (a pole stood in the middle of one, 2026-10-10): nothing stands on
 * the road. The number taken.
 */
export function clearBulbs(doc: RoadDoc, net: Network): number {
  let taken = 0;
  for (const [nodeId, byLevel] of net.junctions) {
    const node = doc.node(nodeId);
    if (!node || node.end !== 'bulb' || node.incident.length !== 1) continue;
    const ring = byLevel.get(Level.Asphalt)?.ring;
    if (!ring || ring.isEmpty) continue;
    const poly = ring.flatten();
    const reach = BULB_RADIUS + BULB_RETURN * 2;
    const inside = (p: Vec2): boolean => Math.hypot(p.x - node.x, p.y - node.y) < reach && pointInPolygon(p, poly);
    for (const pole of [...doc.poles.values()]) {
      if (inside(pole)) { doc.removePole(pole.id); taken++; }
    }
    for (const item of [...doc.elements]) {
      if (inside(item)) taken += doc.removeElements(item.x, item.y, 1e-6, item.kind);
    }
  }
  return taken;
}
