import { normalizeAngle } from '@core/scalar';
import { type Vec2, addScaled, angleOf, dist, fromAngle, normalize, sub } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network, SegmentRibbon } from '@world/network';
import type { ChangeRect } from '@world/changes';
import { orientedPolyline } from '@world/geometry';
import { casingHalf } from '@world/roadTypes';
import { segSeg } from '@core/intersect';
import { roadStructure } from '@world/structures';
import { GRID_STEP, onGrid, snapToGrid } from '@world/grid';
import { m } from '@world/units';

type AnchorKind = 'node' | 'segment' | 'free';

export interface Anchor {
  readonly kind: AnchorKind;
  readonly at: Vec2;
  readonly node?: NodeId;
  readonly segment?: SegmentId;
  /** Arc position along the segment, for `segment` anchors. */
  readonly s?: number;
}

export interface SnapResult {
  readonly at: Vec2;
  /** What produced the snap, for the on-screen guide label. */
  readonly guide: 'network' | 'continue' | 'perpendicular' | 'orthogonal' | 'angle' | null;
  readonly angleDeg: number;
  readonly length: number;
}

/** Angular snap cone, in radians. */
const CONE = (7.5 * Math.PI) / 180;
/** Length quantum, in world units. */
const LENGTH_STEP = m(4);
const LENGTH_TOLERANCE = m(1.68);

/** The road tool's snapping, as Cities: Skylines II lays it out: one switch for all of it, and each kind on its own. */
export interface RoadSnap {
  readonly on: boolean;
  readonly angles: boolean;
  readonly grid: boolean;
}
const ROAD_SNAP_KEY = 'roadcraft.roadSnap';
let roadSnapState: RoadSnap = { on: true, angles: true, grid: true };
try {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(ROAD_SNAP_KEY);
  if (raw) {
    const v = JSON.parse(raw) as Partial<RoadSnap>;
    roadSnapState = { on: v.on !== false, angles: v.angles !== false, grid: v.grid !== false };
  }
} catch {
  // Not kept: the defaults stand.
}
/** The grid the road snap lands on: the 1 m subdivision, or - while the grid is drawn (the road panel's Grid) */
let gridSnapStep = GRID_STEP;
/** Where the snapped points sit within a cell: on its lines (0), or - for a road an odd number of cells wide */
let gridSnapOffset = 0;
export function setGridSnapStep(step: number, offset = 0): void { gridSnapStep = step; gridSnapOffset = offset; }
export function roadSnap(): RoadSnap {
  return roadSnapState;
}
export function setRoadSnap(patch: Partial<RoadSnap>): void {
  roadSnapState = { ...roadSnapState, ...patch };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ROAD_SNAP_KEY, JSON.stringify(roadSnapState));
  } catch {
    // Not kept between sessions; it still applies now.
  }
}

/** DO NOT walk `net.ribbons` / `doc.segments` instead, and DO NOT go through `Network.ribbonsMeeting`: its order table */
export function ribbonsNear(net: Network, rect: ChangeRect): SegmentRibbon[] {
  const out: SegmentRibbon[] = [];
  for (const id of net.segmentCells.idsMeeting(rect)) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) out.push(ribbon);
  }
  return out;
}

/** @perInput Finds what the pointer is over: an existing node, a point on an existing road, or open ground. */
export function findAnchor(
  doc: RoadDoc,
  net: Network,
  p: Vec2,
  zoom: number,
  exclude?: ReadonlySet<NodeId>,
  targetHeightOffset?: number,
): Anchor {
  const nodeRadius = 30 / zoom;
  const pickRadius = 26 / zoom;
  let best: Anchor = { kind: 'free', at: p };
  let bestScore = Infinity;
  let bestNode: NodeId | null = null;

  // DO NOT go back to `doc.nodes` / `doc.segments` here: it runs on every pointer move.
  const reach = Math.max(nodeRadius, pickRadius);
  const near = ribbonsNear(net, [p.x - reach, p.y - reach, p.x + reach, p.y + reach]);

  // Equal distances go to the smaller id, which is the first the old walk over `doc.nodes` met
  for (const ribbon of near) {
    const seg = doc.segment(ribbon.id);
    if (!seg) continue;
    for (let end = 0; end < 2; end++) {
      const node = doc.node(end === 0 ? seg.a : seg.b);
      if (!node) continue;
      if (exclude?.has(node.id)) continue;
      if (targetHeightOffset !== undefined &&
        Math.abs(node.heightOffset - targetHeightOffset) > m(0.3)) continue;
      const d = dist(p, node);
      if (d > nodeRadius) continue;
      if (d < bestScore || (d === bestScore && bestNode !== null && node.id < bestNode)) {
        bestScore = d;
        bestNode = node.id;
        best = { kind: 'node', at: { x: node.x, y: node.y }, node: node.id };
      }
    }
  }

  // A node inside its pick radius owns the gesture.
  if (best.kind === 'node') return best;

  let bestSegment: SegmentId | null = null;
  for (const ribbon of near) {
    const id = ribbon.id;
    const seg = doc.segment(id);
    if (!seg) continue;
    // The profile is the ribbon's own (`makeRibbon`, made from this segment)
    const segRadius = Math.max(pickRadius, casingHalf(ribbon.road));
    const pl = net.polylines.get(doc, id);
    const q = p;
    // Reject by bounding box first.
    const bb = pl.bbox;
    if (
      q.x < bb.minX - segRadius ||
      q.x > bb.maxX + segRadius ||
      q.y < bb.minY - segRadius ||
      q.y > bb.maxY + segRadius
    ) {
      continue;
    }
    const hit = pl.closestPoint(q);
    if (hit.distance > segRadius) continue;
    if (targetHeightOffset !== undefined) {
      const fraction = hit.s / Math.max(1e-6, pl.length);
      const a = doc.node(seg.a)?.heightOffset ?? 0;
      const b = doc.node(seg.b)?.heightOffset ?? 0;
      const height = a + (b - a) * fraction + roadStructure(seg.structure).clearance;
      if (Math.abs(height - targetHeightOffset) > m(0.3)) continue;
    }
    // Equal distances to the smaller id, the first the old walk over `doc.segments` met.
    if (hit.distance < bestScore || (hit.distance === bestScore && bestSegment !== null && id < bestSegment)) {
      bestScore = hit.distance;
      bestSegment = id;
      best = { kind: 'segment', at: hit.point, segment: id, s: hit.s };
    }
  }

  return best;
}

/** Where a road starts: a junction or a road it is drawn from keeps its exact point */
export function snapRoadStart(anchor: Anchor): Anchor {
  const snap = roadSnapState;
  if (anchor.kind !== 'free' || !snap.on || !snap.grid) return anchor;
  return { kind: 'free', at: snapToGrid(anchor.at, gridSnapStep, gridSnapOffset) };
}

/** @perInput Free road drawing follows the pointer exactly, snapping only to compatible networks. */
export function snapRoadEndpoint(
  doc: RoadDoc, net: Network, start: Anchor, raw: Vec2, zoom: number, heightOffset: number,
): SnapResult {
  const snap = roadSnapState;
  if (snap.on && (snap.angles || snap.grid)) {
    return snapEndpoint(doc, net, start, raw, zoom, {
      heightOffset,
      angles: snap.angles,
      lengthStep: 0,
      grid: snap.grid,
    });
  }
  const anchor = findAnchor(doc, net, raw, zoom, undefined, heightOffset);
  const at = anchor.at;
  const v = sub(at, start.at);
  return {
    at,
    guide: anchor.kind === 'free' ? null : 'network',
    angleDeg: (angleOf(v) * 180) / Math.PI,
    length: dist(start.at, at),
  };
}

/** Snaps a draft endpoint. */
/** The heading a drag is allowed to take, and why. */
function snapHeading(
  doc: RoadDoc,
  start: Anchor,
  heading: number,
  landing?: number,
): { angle: number; guide: SnapResult['guide'] } {
  const candidates: { angle: number; guide: SnapResult['guide'] }[] = [];
  let gridOnly = false;

  if (start.node !== undefined) {
    const node = doc.node(start.node);
    for (const segId of node?.incident ?? []) {
      const seg = doc.segment(segId);
      if (!seg) continue;
      const pl = orientedPolyline(doc, seg, start.node);
      const look = Math.min(m(4.8), Math.max(m(0.4), pl.length * 0.2));
      const outgoing = angleOf(normalize(sub(pl.sampleAt(look).p, pl.point(0))));
      candidates.push({ angle: outgoing + Math.PI, guide: 'continue' });
      candidates.push({ angle: outgoing + Math.PI / 2, guide: 'perpendicular' });
      candidates.push({ angle: outgoing - Math.PI / 2, guide: 'perpendicular' });
    }
  }

  if (landing !== undefined) {
    // Landing on a road, the angles that matter are the ones to THAT road
    candidates.push({ angle: landing + Math.PI / 2, guide: 'perpendicular' });
    candidates.push({ angle: landing - Math.PI / 2, guide: 'perpendicular' });
    for (let i = 0; i < 24; i++) {
      candidates.push({ angle: landing + (i * Math.PI) / 12, guide: 'angle' });
    }
  } else {
    // The grid's orthogonals plus 45s, which is the grid most street layouts follow.
    for (const angle of GRID_HEADINGS) candidates.push({ angle, guide: 'orthogonal' });
    // And every 15 degrees from them, as a coarser fallback - but not while the grid is drawn (its cells, `setGridSnapStep`)
    if (gridSnapStep > GRID_STEP) gridOnly = true;
    else for (let i = 0; i < 24; i++) {
      candidates.push({ angle: (i * Math.PI) / 12, guide: 'angle' });
    }
  }

  let angle = heading;
  let guide: SnapResult['guide'] = null;
  // With the grid drawn, one of its eight headings always (each covers 45 degrees).
  let bestDiff = gridOnly ? Math.PI : CONE;

  for (const c of candidates) {
    const diff = Math.abs(normalizeAngle(c.angle - heading));
    if (diff < bestDiff) {
      bestDiff = diff;
      angle = c.angle;
      guide = c.guide;
    }
  }

  return { angle, guide };
}

/** Where a ray from `from` along `dir` first crosses a polyline, or `null`. */
function rayHitsPolyline(
  from: Vec2,
  dir: Vec2,
  points: readonly Vec2[],
  reach: number,
): Vec2 | null {
  const to = addScaled(from, dir, reach);
  let best: Vec2 | null = null;
  let bestT = Infinity;
  for (let i = 1; i < points.length; i++) {
    const hit = segSeg(from, to, points[i - 1] as Vec2, points[i] as Vec2);
    if (!hit) continue;
    if (hit.t < bestT) {
      bestT = hit.t;
      best = hit.point;
    }
  }
  return best;
}

export interface SnapOptions {
  /** Only roads at this height are joined (the road tool's level). */
  readonly heightOffset?: number;
  /** Pull the heading to the candidate angles. Default on. */
  readonly angles?: boolean;
  /** Lengths in whole steps of this many world units, always (a zone cell). */
  readonly lengthStep?: number;
  /** The end on the 1 m grid (`grid.ts`). Default off. */
  readonly grid?: boolean;
}

/** @perInput Runs once a pointer move (the snap under the cursor): nothing it reaches may walk the map. */
export function snapEndpoint(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  raw: Vec2,
  zoom: number,
  options: SnapOptions = {},
): SnapResult {
  const useAngles = options.angles ?? true;
  const network = findAnchor(doc, net, raw, zoom, undefined, options.heightOffset);

  // LANDING ON A NODE takes the node, exactly, and no angle can be negotiated
  if (network.kind === 'node') {
    const v = sub(network.at, start.at);
    return {
      at: network.at,
      guide: 'network',
      angleDeg: (angleOf(v) * 180) / Math.PI,
      length: dist(start.at, network.at),
    };
  }

  // LANDING ON A ROAD used to do the same
  if (network.kind === 'segment' && network.segment !== undefined && useAngles) {
    const target = net.polylines.get(doc, network.segment);
    const points = target.toPoints();
    const reach = dist(start.at, raw) * 2 + 1;
    const heading = angleOf(sub(raw, start.at));
    // The target's direction where the new road meets it.
    const contact = { s: 0, distance: 0 };
    const tangentAt = (p: Vec2): number => {
      target.closestInto(p.x, p.y, contact);
      return angleOf(target.sampleAt(contact.s).t);
    };
    let snapped = snapHeading(doc, start, heading, tangentAt(network.at));
    let hit = rayHitsPolyline(start.at, fromAngle(snapped.angle), points, reach);
    if (hit) {
      const again = snapHeading(doc, start, heading, tangentAt(hit));
      const second = rayHitsPolyline(start.at, fromAngle(again.angle), points, reach);
      if (second) {
        snapped = again;
        hit = second;
      }
    }
    // The snapped landing has to be NEAR WHERE THE POINTER IS, or it is not a snap, it is a different road.
    const reachable = 40 / zoom;
    if (hit && dist(hit, network.at) <= reachable) {
      return {
        at: hit,
        guide: snapped.guide ?? 'network',
        angleDeg: (snapped.angle * 180) / Math.PI,
        length: dist(start.at, hit),
      };
    }
    // The snapped ray misses the road entirely — the pointer is beside it rather than across it.
    const v = sub(network.at, start.at);
    return {
      at: network.at,
      guide: 'network',
      angleDeg: (angleOf(v) * 180) / Math.PI,
      length: dist(start.at, network.at),
    };
  }

  if (network.kind === 'segment') {
    const v = sub(network.at, start.at);
    return { at: network.at, guide: 'network', angleDeg: (angleOf(v) * 180) / Math.PI, length: dist(start.at, network.at) };
  }

  let length = dist(start.at, raw);
  const heading = angleOf(sub(raw, start.at));
  const snapped = useAngles ? snapHeading(doc, start, heading) : { angle: heading, guide: null };
  const angle = snapped.angle;
  const guide = snapped.guide;

  if (options.lengthStep === undefined) {
    const quantized = Math.round(length / LENGTH_STEP) * LENGTH_STEP;
    if (Math.abs(quantized - length) < LENGTH_TOLERANCE) length = quantized;
  } else if (options.lengthStep > 0) {
    // Whole steps. Under half a step it is still a click, not a road: left as it is.
    const steps = Math.round(length / options.lengthStep);
    if (steps > 0) length = steps * options.lengthStep;
  }

  let at = addScaled(start.at, fromAngle(angle), length);
  if (options.grid) at = onGridAlong(start.at, at, angle, length, options.lengthStep ?? 0);
  return {
    at,
    guide,
    angleDeg: (angleOf(sub(at, start.at)) * 180) / Math.PI,
    length: dist(start.at, at),
  };
}

/** The end of a road moved onto the 1 m grid. */
function onGridAlong(start: Vec2, at: Vec2, angle: number, length: number, lengthStep: number): Vec2 {
  const g = gridSnapStep, o = gridSnapOffset;
  const startOnGrid = onGrid(start, g, o);
  const grid = GRID_HEADINGS;
  const k = grid.findIndex((h) => Math.abs(normalizeAngle(angle - h)) < 1e-9);
  if (startOnGrid && k >= 0) {
    const diagonal = k >= 4;
    const unit = diagonal ? g * Math.SQRT2 : g;
    // A length snap in whole cells on an axis is already on the grid.
    const step = !diagonal && lengthStep > 0 ? lengthStep : unit;
    const steps = Math.max(1, Math.round(length / step));
    const d = fromAngle(grid[k]!);
    return snapToGrid(addScaled(start, d, steps * step), g, o);
  }
  return snapToGrid(at, g, o);
}

/** The grid's eight headings: its two lines both ways, then the diagonals between them. */
const GRID_HEADINGS: readonly number[] = [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI / 4, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];

/** Height of an authored connection, relative to the designed ground, or `fallback` for open ground. */
export function anchorHeightOffset(doc: RoadDoc, net: Network, anchor: Anchor, fallback: number): number {
  if (anchor.kind === 'node' && anchor.node !== undefined) {
    return doc.node(anchor.node)?.heightOffset ?? 0;
  }
  if (anchor.kind === 'segment' && anchor.segment !== undefined) {
    const segment = doc.segment(anchor.segment);
    if (!segment) return 0;
    const length = net.polylines.get(doc, segment.id).length;
    const t = Math.max(0, Math.min(1, (anchor.s ?? 0) / Math.max(1e-6, length)));
    const a = doc.node(segment.a)?.heightOffset ?? 0;
    const b = doc.node(segment.b)?.heightOffset ?? 0;
    return a + (b - a) * t + roadStructure(segment.structure).clearance;
  }
  return fallback;
}

/** A nearby road at another height is a crossing, not an accidental junction. */
export function anchorForHeight(doc: RoadDoc, net: Network, anchor: Anchor, heightOffset: number): Anchor {
  return anchor.kind !== 'free' && Math.abs(anchorHeightOffset(doc, net, anchor, heightOffset) - heightOffset) > m(0.3)
    ? { kind: 'free', at: anchor.at }
    : anchor;
}
