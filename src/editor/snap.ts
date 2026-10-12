import { normalizeAngle } from '@core/scalar';
import { type Vec2, addScaled, angleOf, dist, fromAngle, normalize, sub } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { carryPolyline, nodeChart, orientedPolyline } from '@world/geometry';
import { chartToChartInto, faceGridHeading, inChartInto, pointerChartOf } from '@world/planet/charts';
import type { FacePoint } from '@core/cubeSphere';

const chartToChart = (from: number, to: number, p: Vec2): Vec2 => chartToChartInto(from, to, p.x, p.y, { x: 0, y: 0 });
import { casingHalf, roadProfile } from '@world/roadTypes';
import { segSeg } from '@core/intersect';
import { roadStructure } from '@world/structures';
import { GRID_STEP, onGrid, snapToGrid } from '@world/grid';
import { m } from '@world/units';

export type AnchorKind = 'node' | 'segment' | 'free';

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

/**
 * The road tool's snapping, as Cities: Skylines II lays it out: one switch
 * for all of it, and each kind on its own. Connecting to a road or a junction
 * is not part of it - a road drawn onto another always joins it.
 *
 * - `angles`: square to the world and to the roads it starts from or lands
 *   on, 45 degrees, and every 15 degrees;
 * - `grid`: points on the 1 m subdivision of the universal grid (`grid.ts`),
 *   the start of a road as well as its end.
 * Roads lay out no zoning grid any more (lots are drawn in the Zoning tool),
 * so their length is not snapped to one.
 */
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
/**
 * The grid the road snap lands on: the 1 m subdivision, or - while the grid
 * is drawn (the road panel's Grid) - the 10 m cells the player sees, so a road
 * runs along their lines and ends on their corners.
 */
let gridSnapStep = GRID_STEP;
/**
 * Where the snapped points sit within a cell: on its lines (0), or - for a
 * road an odd number of cells wide - in its middle (half a cell), so the road
 * fills whole cells between the lines instead of straddling one (the player,
 * 2026-10-06: "dentro do grid e não na linha").
 */
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

/**
 * Finds what the pointer is over: an existing node, a point on an existing
 * road, or open ground.
 *
 * Radii are divided by zoom so that pick tolerance is constant in screen
 * pixels, and node candidates are biased so a junction wins over attaching
 * mid-segment — the same behaviour the V6 monolith had, kept deliberately.
 */
export function findAnchor(
  doc: RoadDoc,
  net: Network,
  p: Vec2,
  zoom: number,
  exclude?: ReadonlySet<NodeId>,
  targetHeightOffset?: number,
): Anchor {
  const nodeRadius = 30 / zoom;
  let best: Anchor = { kind: 'free', at: p };
  let bestScore = Infinity;
  // On the planet the pointer's point is written on one chart (the gesture's,
  // `world/planet/charts.ts`): every node and road is read on it, and what is
  // found is given on it.
  const chart = pointerChartOf(p.x, p.y);
  const on: FacePoint = { x: 0, y: 0 };

  for (const node of doc.nodes.values()) {
    if (exclude?.has(node.id)) continue;
    if (targetHeightOffset !== undefined &&
      Math.abs(node.heightOffset - targetHeightOffset) > m(0.3)) continue;
    inChartInto(chart, node.x, node.y, on);
    const d = dist(p, on);
    if (d > nodeRadius) continue;
    if (d < bestScore) {
      bestScore = d;
      best = { kind: 'node', at: { x: on.x, y: on.y }, node: node.id };
    }
  }

  // A node inside its pick radius owns the gesture. Comparing its distance
  // with a segment distance was not enough: at a shared endpoint, subpixel
  // screen-to-world rounding can make the node a few millionths away while
  // the projected segment is exactly zero away. The segment then stole the
  // click and the Move tool panned the camera instead of moving the junction.
  if (best.kind === 'node') return best;
  const carried = new Map<number, Vec2>();

  for (const [id, seg] of doc.segments) {
    // A pointer visibly inside a road must be able to attach to that road even
    // when zoomed in.  A screen-only radius shrank below the physical casing at
    // high zoom, creating endpoints that overlapped the rendered road while
    // remaining topologically disconnected.
    const segRadius = Math.max(
      26 / zoom,
      casingHalf(roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking)),
    );
    const pl = net.polylines.get(doc, id);
    // The pointer on the road's own chart (one carry per chart, not per road).
    const own = net.polylines.chart(doc, id);
    let q = p;
    if (own !== chart) {
      q = carried.get(own) ?? chartToChart(chart, own, p);
      carried.set(own, q);
    }
    // Reject by bounding box first. `closestPoint` walks every flattened point
    // of the polyline, and this ran on EVERY segment of the map for every
    // pointer move — so simply sliding the mouse across a large map cost a full
    // sweep of its geometry, which is felt as lag long before anything is
    // clicked. A segment whose box is further than the snap radius cannot hold
    // the closest point, and the box test is four comparisons.
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
    if (hit.distance < bestScore) {
      bestScore = hit.distance;
      best = { kind: 'segment', at: own === chart ? hit.point : chartToChart(own, chart, hit.point), segment: id, s: hit.s };
    }
    void seg;
  }

  return best;
}

/**
 * Where a road starts: a junction or a road it is drawn from keeps its exact
 * point; open ground is moved onto the 1 m grid when the grid snap is on.
 */
export function snapRoadStart(anchor: Anchor): Anchor {
  const snap = roadSnapState;
  if (anchor.kind !== 'free' || !snap.on || !snap.grid) return anchor;
  return { kind: 'free', at: snapToGrid(anchor.at, gridSnapStep, gridSnapOffset) };
}

/** Free road drawing follows the pointer exactly, snapping only to compatible networks. */
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

/**
 * Snaps a draft endpoint.
 *
 * Network snapping wins outright. Otherwise the heading is pulled to a
 * candidate angle — continuing or crossing an incident road at the start
 * anchor, or a world orthogonal — and the length is quantized.
 *
 * Angular snapping is not decoration. Junction quality depends on legs meeting
 * at sane angles: a fork of a few degrees forces an enormous separation setback
 * and produces a gore no corner solver can trace cleanly.
 */
/**
 * The heading a drag is allowed to take, and why.
 *
 * ONE definition, because two callers need the same answer: a road drawn into
 * open ground and a road drawn onto another road. It used to exist only inline
 * in the first case, so landing on an existing road accepted any angle at all —
 * the very shape the editor otherwise refuses.
 */
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
      // On the gesture's chart: neighbouring charts can be turned against each other.
      const pl = carryPolyline(orientedPolyline(doc, seg, start.node), nodeChart(doc, start.node), pointerChartOf(start.at.x, start.at.y));
      const look = Math.min(m(4.8), Math.max(m(0.4), pl.length * 0.2));
      const outgoing = angleOf(normalize(sub(pl.sampleAt(look).p, pl.point(0))));
      candidates.push({ angle: outgoing + Math.PI, guide: 'continue' });
      candidates.push({ angle: outgoing + Math.PI / 2, guide: 'perpendicular' });
      candidates.push({ angle: outgoing - Math.PI / 2, guide: 'perpendicular' });
    }
  }

  if (landing !== undefined) {
    // Landing on a road, the angles that matter are the ones to THAT road:
    // square to it first, then every 15 degrees from its own direction. The
    // world grid used to be offered here as well, and against any road not
    // itself on that grid it won - a street drawn square onto an avenue at 21
    // degrees was pulled to 105, and onto a bend to the world axis rather than
    // the bend's normal: the new road visibly swung off where it was drawn.
    candidates.push({ angle: landing + Math.PI / 2, guide: 'perpendicular' });
    candidates.push({ angle: landing - Math.PI / 2, guide: 'perpendicular' });
    for (let i = 0; i < 24; i++) {
      candidates.push({ angle: landing + (i * Math.PI) / 12, guide: 'angle' });
    }
  } else {
    // The grid's orthogonals plus 45s, which is the grid most street layouts
    // follow - on the planet the face grid's own lines where the road starts
    // (`gridHeadings`), not the map's axes.
    const grid = gridHeadings(start.at);
    for (const angle of grid) candidates.push({ angle, guide: 'orthogonal' });
    // And every 15 degrees from them, as a coarser fallback - but not while
    // the grid is drawn (its cells, `setGridSnapStep`): a road then runs along
    // its lines or its diagonals, the nearest of the eight, whatever the drag.
    // A drag 20 degrees off a line took the 15 or 30 and crossed the cells
    // askew, its ends alone on the grid (the player, 2026-10-10).
    if (gridSnapStep > GRID_STEP) gridOnly = true;
    else for (let i = 0; i < 24; i++) {
      candidates.push({ angle: grid[0]! + (i * Math.PI) / 12, guide: 'angle' });
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

/**
 * Where a ray from `from` along `dir` first crosses a polyline, or `null`.
 *
 * Used to land a snapped heading on the road being drawn onto: the angle is
 * decided first and the contact point follows from it, instead of the contact
 * point being taken and the angle left to chance.
 */
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
  /**
   * Lengths in whole steps of this many world units, always (a zone cell).
   * Absent: the old soft quantum - 10 units when within 4.2 of it. 0: none.
   */
  readonly lengthStep?: number;
  /** The end on the 1 m grid (`grid.ts`). Default off. */
  readonly grid?: boolean;
}

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

  // LANDING ON A NODE takes the node, exactly, and no angle can be negotiated:
  // the whole point is that the two roads share that one point.
  if (network.kind === 'node') {
    const v = sub(network.at, start.at);
    return {
      at: network.at,
      guide: 'network',
      angleDeg: (angleOf(v) * 180) / Math.PI,
      length: dist(start.at, network.at),
    };
  }

  // LANDING ON A ROAD used to do the same, and that is why a road drawn into
  // open ground obeyed the angle snap while a road drawn onto another one could
  // be laid at any angle at all: this early return skipped the whole snap.
  //
  // A segment is a LINE, not a point. So the heading is snapped first, exactly
  // as it would be in open ground, and the snapped ray is then intersected with
  // the road being landed on. The result still lands on the road — the join is
  // as solid as before — and it arrives at an angle the editor is willing to
  // build.
  if (network.kind === 'segment' && network.segment !== undefined && useAngles) {
    // The road landed on, on the gesture's chart.
    const target = net.polylines.at(doc, network.segment, pointerChartOf(start.at.x, start.at.y));
    const points = target.toPoints();
    const reach = dist(start.at, raw) * 2 + 1;
    const heading = angleOf(sub(raw, start.at));
    // The target's direction where the new road meets it. Taken at the contact
    // first, then once more where the snapped ray actually lands, which on a
    // bend is a little further along.
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
    // The snapped landing has to be NEAR WHERE THE POINTER IS, or it is not a
    // snap, it is a different road.
    //
    // A ray locked to an angle can cross the target far from the contact the
    // user aimed at — around a bend, or near a junction at the other end. Taken
    // blindly, that cuts the target there instead, and a cut a few units from
    // an existing node leaves a stub shorter than the road is wide. Measured
    // after the first version of this: a 10.51-unit segment between two
    // junctions each asking for about 25 units of setback, which is a link that
    // cannot give either of them room and degenerates into the pale slivers
    // that appeared fanning across the asphalt.
    //
    // The allowance is the anchor's own reach with a little margin, so the snap
    // still bends the last few pixels of a drag and never relocates it.
    const reachable = 40 / zoom;
    if (hit && dist(hit, network.at) <= reachable) {
      return {
        at: hit,
        guide: snapped.guide ?? 'network',
        angleDeg: (snapped.angle * 180) / Math.PI,
        length: dist(start.at, hit),
      };
    }
    // The snapped ray misses the road entirely — the pointer is beside it
    // rather than across it. Taking the raw contact keeps the connection the
    // user is clearly asking for; refusing it would just feel broken.
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

/**
 * The end of a road moved onto the 1 m grid.
 *
 * Along a world axis or a diagonal from a start on the grid, the grid points
 * lie ON the snapped heading, so the end slides along it to the nearest one
 * (a whole number of metres; of whole cells when the length snap asks for it)
 * and the angle stays exact. At any other heading the nearest grid point is
 * taken, and the heading moves the little it must.
 */
function onGridAlong(start: Vec2, at: Vec2, angle: number, length: number, lengthStep: number): Vec2 {
  const g = gridSnapStep, o = gridSnapOffset;
  const startOnGrid = onGrid(start, g, o);
  const grid = gridHeadings(start);
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

/**
 * The grid's eight headings at a point: its two lines both ways, then the
 * diagonals between them. The world's axes and 45s on the flat map; on the
 * planet the face grid's lines through the point (`faceGridHeading`), which a
 * piece's map turns.
 */
function gridHeadings(p: Vec2): number[] {
  const e = faceGridHeading(p.x, p.y, 0), n = faceGridHeading(p.x, p.y, 1);
  const d1 = e + normalizeAngle(n - e) / 2, d2 = n + normalizeAngle(e + Math.PI - n) / 2;
  return [e, n, e + Math.PI, n + Math.PI, d1, d2, d1 + Math.PI, d2 + Math.PI];
}

/**
 * Height of an authored connection, relative to the designed ground, or
 * `fallback` for open ground. Shared by the road tool and the fuzzer, so the
 * defect detector draws roads the way the player does.
 */
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
