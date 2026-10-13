import { EPS } from '@core/scalar';
import { Polyline } from '@core/polyline';
import { filletCorner } from '@core/fillet';
import { lineLine } from '@core/intersect';
import { offsetPolyline } from '@core/offset';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from './ids';
import type { RoadDoc } from './doc';
import { m, stepsIn } from './units';
import type { Network } from './network';
import { Level } from './roadTypes';
import { bandMid, bandWidth, sectionOf } from './section';
import { orientedPolyline } from './geometry';
import { CROSSWALK_DEPTH } from './approach';
import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';
import { levelPolygons } from './surfaces';
import type { SurfaceLevel } from './roadTypes';
import { pointInPolygon } from '@core/polygon';
import type { MultiPoly } from '@core/clipper';
import type { RoadStructure } from './structures';
import { bulbLine } from './junction/bulb';

/**
 * WHERE PEOPLE WALK, as lanes: the pedestrian network of the city.
 *
 * Built from the cross-section (`section.ts`) and the junctions, the way a
 * traffic simulator builds it (SUMO: sidewalks are lanes, "walkingareas" join
 * them at a junction's corners, "crossings" take them over the carriageway):
 *
 *  - a FOOTWAY runs down the middle of the through zone on each side of a
 *    road, from one junction mouth to the other;
 *  - a CORNER joins, round each corner of a junction, the footway that leaves
 *    it on one leg to the footway on the next: the two walking lines
 *    filleted about the kerb return's own centre, so the line keeps its
 *    distance from the kerb all the way round. Where a road only bends (a
 *    node of two legs and no junction) a short corner joins its two halves;
 *  - a CROSSING runs over the carriageway on the zebra, from one footway (or
 *    corner) to the other side's.
 *
 * Walkways are joined by TOPOLOGY - the ends of footways at the same road
 * node, on the same side - never by being close: a footway on a viaduct
 * passes over one on the ground without touching it, and a footway on a ramp
 * joins the one at its foot.
 *
 * Every walkway is a centreline with a usable width. A person walks ALONG
 * one, at a distance `s` that only grows, and keeps a lateral offset within
 * its width: there is no point to overshoot and no corner to choose. The two
 * pedestrian models before this one each rebuilt their paths from the paving
 * left over by polygon booleans, and both walked erratically for it (study
 * of 2026-10-01).
 */

export type WalkwayKind = 'footway' | 'corner' | 'crossing';

export interface WalkNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface Walkway {
  readonly id: number;
  readonly kind: WalkwayKind;
  /** Centreline, from node `a` to node `b`. People walk it either way. */
  readonly path: Polyline;
  /** Usable width, world units: the lateral room a walker keeps within (`hi - lo`). */
  readonly width: number;
  /**
   * How far a walker's centreline position may lie either side of the path,
   * u, measured along the path's LEFT normal (walking from `a` to `b`):
   * from `lo` (negative, its right) to `hi`. A footway reaches from the
   * kerb's outer edge to the footway's outer edge - street furniture stands
   * in part of it and is walked round - so people normally keep to the
   * through zone the path runs down, and step aside into the rest to pass.
   */
  readonly lo: number;
  readonly hi: number;
  /** For a footway or corner, the side the kerb is on (-1 at `lo`, +1 at `hi`); 0 for a crossing. */
  readonly kerb: -1 | 0 | 1;
  readonly a: number;
  readonly b: number;
  /** The road a footway or crossing belongs to. */
  readonly segment?: SegmentId;
  /** The road node a corner or crossing belongs to. */
  readonly node?: NodeId;
  /** Which deck it is on. */
  readonly structure: RoadStructure;
  /**
   * A crossing with no zebra painted: across the end of a road that leads
   * nowhere. Walkers take a gap in the traffic there; nothing stops for them.
   */
  readonly unmarked?: true;
}

/** A road at grade lifted more than this by its own heights is a viaduct for whoever walks it, u. */
export const RAISED_BY_HAND = m(2.5);

/**
 * The deck a road's footways belong to. A road at grade raised by hand is a
 * viaduct for whoever walks it: kept with the raised decks, never joined to
 * the ground footways it passes over.
 */
export function deckOf(doc: RoadDoc, id: SegmentId): RoadStructure {
  const seg = doc.segment(id);
  const structure = seg?.structure ?? 'ground';
  if (!seg || structure !== 'ground') return structure;
  const lift = ((doc.node(seg.a)?.heightOffset ?? 0) + (doc.node(seg.b)?.heightOffset ?? 0)) / 2;
  return lift > RAISED_BY_HAND ? 'elevated' : 'ground';
}

/** Passes of smoothing over a corner's line. */
const SMOOTH_PASSES = 3;

/** Length over which a corner eases off its footway's straight run onto the walking contour, u. */
const EASE = m(0.6);
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Ends of two footways at one road node closer than this are one point, u. */
const JOIN = m(0.02);
/** A corner's curve leaves each footway along it for this share of the gap between the ends (fallback only). */
const TANGENT_SHARE = 0.4;
/** Points per fallback curve. */
const CURVE_STEPS = 10;
/** Tightest turn a walking line is given round a corner, u (1 m). */
const MIN_CORNER_R = m(1);
/** A crossing lands on a walkway no further than this beyond its usable width, u. */
const LAND_REACH = m(0.8);

export class WalkGraph {
  readonly nodes: WalkNode[] = [];
  readonly ways: Walkway[] = [];
  /** The walkways meeting at each node. */
  readonly at = new Map<number, number[]>();

  node(p: Vec2): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x: p.x, y: p.y });
    return id;
  }

  add(way: Omit<Walkway, 'id'>): Walkway {
    const w: Walkway = { ...way, id: this.ways.length };
    this.ways.push(w);
    this.link(w.a, w.id);
    this.link(w.b, w.id);
    return w;
  }

  private link(node: number, way: number): void {
    const list = this.at.get(node);
    if (list) list.push(way);
    else this.at.set(node, [way]);
  }

  /** Cuts a walkway in two at arc length `s`; returns the node there (an end's node when `s` is at an end). */
  split(way: Walkway, s: number): number {
    if (s <= JOIN) return way.a;
    if (s >= way.path.length - JOIN) return way.b;
    const first = way.path.sub(0, s), second = way.path.sub(s, way.path.length);
    const mid = this.node(first.sampleAt(first.length).p);
    this.ways[way.id] = { ...way, path: first, b: mid };
    const atB = this.at.get(way.b)!;
    atB.splice(atB.indexOf(way.id), 1);
    this.link(mid, way.id);
    const { id: _id, path: _path, a: _a, ...rest } = way;
    this.add({ ...rest, path: second, a: mid });
    return mid;
  }
}

/** A cubic curve from `p0` heading `d0` to `p1` arriving heading `d1`, as a polyline. */
function hermite(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2): Polyline {
  const gap = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const k = gap * TANGENT_SHARE;
  const c0 = { x: p0.x + d0.x * k, y: p0.y + d0.y * k };
  const c1 = { x: p1.x - d1.x * k, y: p1.y - d1.y * k };
  const pts: Vec2[] = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS, u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
    });
  }
  return Polyline.fromPoints(pts);
}

/**
 * The walking line round a corner: along the footway of one leg, round an
 * arc, along the footway of the next - the two walking lines filleted where
 * they meet. Given the kerb return's radius less the walking line's inset, the
 * arc is concentric with the kerb. Leaves each end along its footway: no kink.
 */
function cornerPath(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2, radius: number): Polyline {
  const meet = lineLine(p0, d0, p1, d1, 1e-6);
  // Parallel lines (a road carried straight on), or lines meeting behind
  // either end: a smooth curve between the ends.
  if (!meet || meet.sA <= 0 || meet.sB >= 0) return hermite(p0, d0, p1, d1);
  const x = meet.point;
  const awayA = { x: -d0.x, y: -d0.y };
  const psi = Math.acos(Math.max(-1, Math.min(1, awayA.x * d1.x + awayA.y * d1.y)));
  // No longer than the room each end leaves before the corner.
  const room = Math.min(meet.sA, -meet.sB) * Math.tan(psi / 2);
  const f = filletCorner(x, awayA, d1, Math.min(Math.max(radius, MIN_CORNER_R), room));
  if (!f) return hermite(p0, d0, p1, d1);
  const pts: Vec2[] = [p0];
  const a0 = Math.atan2(f.ta.y - f.c.y, f.ta.x - f.c.x);
  let sweep = Math.atan2(f.tb.y - f.c.y, f.tb.x - f.c.x) - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (sweep * k) / steps;
    pts.push({ x: f.c.x + Math.cos(a) * f.r, y: f.c.y + Math.sin(a) * f.r });
  }
  pts.push(p1);
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 1e-6);
  return Polyline.fromPoints(clean);
}

interface FootwayEnd {
  readonly way: Walkway;
  readonly node: number;
  /** Side of the road: +1 left of the centreline as stored (a to b), -1 right. */
  readonly side: 1 | -1;
  /** How far the walking line lies beyond the kerb's outer edge, u. */
  readonly inset: number;
  /** How far the footway reaches beyond the walking line, away from the road, u. */
  readonly outer: number;
  /** Which side of a walker walking INTO the node the kerb is on: -1 its right, +1 its left. */
  readonly kerbSide: 1 | -1;
  /** The end at this road node, and the direction walking INTO the node. */
  readonly p: Vec2;
  readonly into: Vec2;
}

/**
 * The walking lines of one deck at one inset: the outline of everything a
 * kerb bounds (carriageway and kerb stone, as drawn), grown by the inset.
 * Each closed contour runs at exactly that distance from the kerb's outer
 * edge all the way round - along a road, round a junction's kerb return, a
 * bevelled sharp bend, the end of a hairpin - which is what a walking line
 * is. Polygon offsetting (Clipper2) does it for any shape the junction
 * builder and the road ribbons draw together; the junction's own ring alone
 * does not (it cuts the outside of a sharp bend straight across the road).
 */
class WalkingLines {
  private readonly cache = new Map<string, Polyline[]>();
  private readonly edges = new Map<string, Polyline[]>();
  constructor(private readonly net: Network) {}

  /** The merged rings of a level on the decks it lets in. */
  private polygons(level: SurfaceLevel, include: (id: SegmentId) => boolean): MultiPoly {
    return levelPolygons(this.net, level, include);
  }

  private readonly pavings = new Map<string, MultiPoly>();

  /** Everything paved for walking or driving on one deck, out to the footway's outer edge. */
  paving(deck: RoadStructure): MultiPoly {
    let known = this.pavings.get(deck);
    if (!known) {
      // The footway level alone: `surfaces` unions all four levels of the map
      // to hand back one (docs/performance.md #11).
      known = this.polygons(Level.Sidewalk, (id) => deckOf(this.net.doc, id) === deck);
      this.pavings.set(deck, known);
    }
    return known;
  }

  /** The paving of a deck as point rings with their boxes, made once (`onPaving`). */
  private readonly pavingRings = new Map<string, { outer: PavingRing | null; holes: PavingRing[] }[]>();

  /**
   * Whether a point is on the paving of a deck. The rings were copied into
   * fresh point objects on every call - the whole town's footway outline for
   * every point of every corner - which was a tenth of a road edit.
   */
  onPaving(deck: RoadStructure, p: Vec2): boolean {
    let polys = this.pavingRings.get(deck);
    if (!polys) {
      polys = this.paving(deck).map(([outerRing, ...holes]) => ({
        outer: outerRing ? pavingRing(outerRing) : null,
        holes: holes.map(pavingRing),
      }));
      this.pavingRings.set(deck, polys);
    }
    for (const poly of polys) {
      if (!poly.outer || !inRing(p, poly.outer)) continue;
      if (poly.holes.some((h) => inRing(p, h))) continue;
      return true;
    }
    return false;
  }

  private readonly outerIndex = new Map<string, NearestEdge>();
  /**
   * The nearest point of the footway's outer edge on one deck, as the nearest
   * of `outer`'s lines' `closestPoint`s (earlier lines and pieces win ties),
   * read off a grid: every point of every corner used to measure the whole
   * map's edge - one ring of thousands of pieces on a connected network -
   * 46 of the 62 ms a road edit spent here in the default town
   * (docs/performance.md #11).
   */
  nearestOuter(deck: RoadStructure, p: Vec2): { point: Vec2; distance: number } | null {
    let index = this.outerIndex.get(deck);
    if (!index) this.outerIndex.set(deck, index = new NearestEdge(this.outer(deck)));
    return index.nearest(p);
  }

  /** The footway's outer edge on one deck: the outline of the paving, as drawn. */
  outer(deck: RoadStructure): Polyline[] {
    const known = this.edges.get(deck);
    if (known) return known;
    const paving = this.paving(deck);
    const lines: Polyline[] = [];
    for (const poly of paving) for (const ring of poly) {
      if (ring.length >= 3) lines.push(Polyline.fromPoints([...ring.map(([x, y]) => ({ x: x!, y: y! })), { x: ring[0]![0]!, y: ring[0]![1]! }]));
    }
    this.edges.set(deck, lines);
    return lines;
  }

  at(deck: RoadStructure, inset: number): Polyline[] {
    const key = `${deck}:${inset.toFixed(4)}`;
    const known = this.cache.get(key);
    if (known) return known;
    const kerbs = this.polygons(Level.Curb, (id) => deckOf(this.net.doc, id) === deck);
    const paths: PathsD = [];
    for (const poly of kerbs) for (const ring of poly) paths.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
    const grown = inflatePathsD(unionD(paths, [], FillRule.NonZero, 3), inset, JoinType.Round, EndType.Polygon, 2, 3, m(0.008));
    const lines = grown.filter((r) => r.length >= 3).map((r) => Polyline.fromPoints([...r, r[0]!]));
    this.cache.set(key, lines);
    return lines;
  }
}

/** The pieces of some lines on a grid: the nearest point among all of them, reading only the cells near it. */
class NearestEdge {
  private static readonly CELL = m(9.6);
  /** Each piece: ax, ay, bx, by, in line then piece order. */
  private readonly pieces: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private lo = [Infinity, Infinity];
  private hi = [-Infinity, -Infinity];

  constructor(lines: readonly Polyline[]) {
    const C = NearestEdge.CELL;
    for (const line of lines) {
      const xy = line.xy;
      for (let k = 0; k + 3 < xy.length; k += 2) {
        const i = this.pieces.length / 4;
        const ax = xy[k]!, ay = xy[k + 1]!, bx = xy[k + 2]!, by = xy[k + 3]!;
        this.pieces.push(ax, ay, bx, by);
        const x0 = Math.floor(Math.min(ax, bx) / C), x1 = Math.floor(Math.max(ax, bx) / C);
        const y0 = Math.floor(Math.min(ay, by) / C), y1 = Math.floor(Math.max(ay, by) / C);
        this.lo = [Math.min(this.lo[0]!, x0), Math.min(this.lo[1]!, y0)];
        this.hi = [Math.max(this.hi[0]!, x1), Math.max(this.hi[1]!, y1)];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const key = (x + 32768) * 65536 + (y + 32768);
          const list = this.cells.get(key);
          if (list) list.push(i); else this.cells.set(key, [i]);
        }
      }
    }
  }

  nearest(p: Vec2): { point: Vec2; distance: number } | null {
    if (!this.cells.size || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const C = NearestEdge.CELL, P = this.pieces;
    const cx = Math.floor(p.x / C), cy = Math.floor(p.y / C);
    let bestSq = Infinity, bestI = -1, bestX = 0, bestY = 0;
    const seen = new Set<number>();
    const visit = (x: number, y: number): void => {
      const list = this.cells.get((x + 32768) * 65536 + (y + 32768));
      if (!list) return;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const ax = P[i * 4]!, ay = P[i * 4 + 1]!, abx = P[i * 4 + 2]! - ax, aby = P[i * 4 + 3]! - ay;
        const l2 = abx * abx + aby * aby;
        let qx = ax, qy = ay;
        if (l2 >= EDGE_EPS) {
          let t = ((p.x - ax) * abx + (p.y - ay) * aby) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          qx = ax + abx * t; qy = ay + aby * t;
        }
        const d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
        if (d < bestSq || (d === bestSq && i < bestI)) { bestSq = d; bestI = i; bestX = qx; bestY = qy; }
      }
    };
    const reach = Math.max(Math.abs(cx - this.lo[0]!), Math.abs(cx - this.hi[0]!), Math.abs(cy - this.lo[1]!), Math.abs(cy - this.hi[1]!));
    for (let r = 0; r <= reach; r++) {
      for (let x = cx - r; x <= cx + r; x++) {
        visit(x, cy - r);
        if (r) visit(x, cy + r);
      }
      for (let y = cy - r + 1; y <= cy + r - 1; y++) {
        visit(cx - r, y);
        visit(cx + r, y);
      }
      // Anything outside the square searched is at least r cells away.
      if (bestI >= 0 && Math.sqrt(bestSq) < r * C) break;
    }
    return bestI < 0 ? null : { point: { x: bestX, y: bestY }, distance: Math.sqrt(bestSq) };
  }
}
/** A piece shorter than this is its first point (`Polyline`'s own threshold). */
const EDGE_EPS = EPS;

interface PavingRing { readonly points: Vec2[]; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
function pavingRing(ring: readonly (readonly number[])[]): PavingRing {
  const points = ring.map(([x, y]) => ({ x: x!, y: y! }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
  return { points, minX, minY, maxX, maxY };
}
/** `pointInPolygon`, skipped when the point is outside the ring's box. */
function inRing(p: Vec2, r: PavingRing): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY && pointInPolygon(p, r.points);
}

/** Points along a polyline at `count + 1` evenly spaced shares of its length. */
function resample(points: readonly Vec2[], count: number): Vec2[] {
  const line = Polyline.fromPoints(points.filter((p, q) => q === 0 || Math.hypot(p.x - points[q - 1]!.x, p.y - points[q - 1]!.y) > 1e-9));
  const out: Vec2[] = [];
  for (let q = 0; q <= count; q++) out.push(line.sampleAt((line.length * q) / count).p);
  return out;
}

/**
 * The stretch of a closed walking line from the point nearest `from` to the
 * point nearest `to`, going the way that passes none of `avoid` (the other
 * footway ends at the junction). Null when the two ends are not on one line.
 */
function stretch(lines: readonly Polyline[], from: Vec2, to: Vec2, avoid: readonly Vec2[]): Vec2[] | null {
  let line: Polyline | null = null, best = Infinity;
  for (const l of lines) {
    const a = l.closestPoint(from), b = l.closestPoint(to);
    if (a.distance + b.distance < best) { best = a.distance + b.distance; line = l; }
  }
  if (!line || best > m(0.8)) return null;
  const total = line.length;
  const sa = line.closestPoint(from).s, sb = line.closestPoint(to).s;
  const avoided = avoid.map((p) => line!.closestPoint(p)).filter((c) => c.distance < m(0.8)).map((c) => c.s);
  // Forward from sa to sb (wrapping), or backward.
  const within = (s: number, s0: number, s1: number): boolean => (s0 <= s1 ? s > s0 && s < s1 : s > s0 || s < s1);
  const forwardClear = !avoided.some((s) => within(s, sa, sb));
  const backwardClear = !avoided.some((s) => within(s, sb, sa));
  if (!forwardClear && !backwardClear) return null;
  const forward = forwardClear && (!backwardClear || ((sb - sa + total) % total) <= ((sa - sb + total) % total));
  const span = forward ? (sb - sa + total) % total : (sa - sb + total) % total;
  // A point every 20 cm: the smoothing below runs point by point.
  const steps = Math.max(2, Math.ceil(stepsIn(span, 0.2)));
  const out: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const s = forward ? sa + (span * k) / steps : sa - (span * k) / steps;
    out.push(line.sampleAt(((s % total) + total) % total).p);
  }
  return out;
}

/** The pedestrian network of the whole map. Pure: the same network gives the same graph. */
export function buildWalkways(net: Network): WalkGraph {
  const steps = walkwaySteps(net);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * `buildWalkways` in steps, a junction's corners at a time: the simulation
 * builds it ahead of a topology change across frames (`SimWorld.prepareVehicleTopology`);
 * in one go it was a stall of about 100 ms in the default town (docs/performance.md #11).
 */
export function* walkwaySteps(net: Network): Generator<void, WalkGraph, void> {
  const g = new WalkGraph();
  const doc = net.doc;
  const ends = new Map<NodeId, FootwayEnd[]>();
  const endAt = (node: NodeId, e: FootwayEnd): void => {
    const list = ends.get(node);
    if (list) list.push(e);
    else ends.set(node, [e]);
  };

  // --- footways: down the middle of each side's through zone
  for (const segId of [...doc.segments.keys()].sort((a, b) => a - b)) {
    const seg = doc.requireSegment(segId);
    const ribbon = net.ribbons.get(segId);
    if (!ribbon) continue;
    const section = sectionOf(ribbon.road, seg.direction);
    if (!section.walkable) continue;
    const centre = ribbon.centre[Level.Sidewalk];
    if (!centre || centre.n < 2 || centre.length < 1e-6) continue;
    const pts = centre.toPoints();
    for (const side of [1, -1] as const) {
      // Each side's own footway (an asymmetric road, docs/VIAS.md V1).
      const zones = side > 0 ? section.left : section.right;
      const mid = bandMid(zones.through);
      const width = bandWidth(zones.through);
      const inset = mid - zones.curb.outer;
      const outer = zones.frontage.outer - mid;
      // `offsetPolyline` offsets to the LEFT for a positive distance.
      const path = Polyline.fromPoints(offsetPolyline(pts, side * mid));
      const first = path.sampleAt(0), last = path.sampleAt(path.length);
      // Along a to b, the path's left is away from the road on the left
      // side (+1), towards it on the right side (-1).
      const lo = side > 0 ? -inset : -outer, hi = side > 0 ? outer : inset;
      const way = g.add({ kind: 'footway', path, width: hi - lo, lo, hi, kerb: side > 0 ? -1 : 1, segment: segId, structure: deckOf(doc, segId), a: g.node(first.p), b: g.node(last.p) });
      void width;
      // Walking into b along the path the kerb is on the right of the left
      // footway; walking into a, the other way, on its left.
      endAt(seg.a, { way, node: way.a, side, inset, outer, kerbSide: side > 0 ? 1 : -1, p: first.p, into: { x: -first.t.x, y: -first.t.y } });
      endAt(seg.b, { way, node: way.b, side, inset, outer, kerbSide: side > 0 ? -1 : 1, p: last.p, into: last.t });
    }
  }

  // --- corners: round each corner of a junction, from one leg's footway to the next's
  const joined = new Set<number>();
  /** The walking line round from one footway end to another, as drawn, or null. */
  const roundCorner = (from: FootwayEnd, to: FootwayEnd, all: readonly FootwayEnd[], walking: WalkingLines): Polyline | null => {
    if (from.way.structure !== to.way.structure) return null;
    const avoid = all.filter((e) => e !== from && e !== to).map((e) => e.p);
    // The stretch round the corner at each footway's own inset: where two
    // roads with footways of different widths meet, the walking line moves
    // from one inset to the other along the corner, easing in and out so it
    // leaves each footway along it.
    const a = stretch(walking.at(from.way.structure, from.inset), from.p, to.p, avoid);
    const b = from.inset === to.inset ? a : stretch(walking.at(to.way.structure, to.inset), from.p, to.p, avoid);
    if (!a || !b) return null;
    const count = Math.max(a.length, b.length) - 1;
    const ra = resample(a, count), rb = resample(b, count);
    const pts: Vec2[] = [];
    for (let q = 0; q <= count; q++) {
      const u = q / count, w = u * u * (3 - 2 * u);
      pts.push({ x: ra[q]!.x + (rb[q]!.x - ra[q]!.x) * w, y: ra[q]!.y + (rb[q]!.y - ra[q]!.y) * w });
    }
    // Where the footway narrows below the walking line's inset (its outer
    // edge tapering faster than the kerb, at a change of road width), the
    // line keeps half its usable width clear of the outer edge instead: it
    // moves towards the kerb by as much as the footway is narrower there.
    for (let q = 1; q < count; q++) {
      const p = pts[q]!;
      const u = q / count, half = (from.way.width + (to.way.width - from.way.width) * u) / 2;
      const edge = walking.nearestOuter(from.way.structure, p);
      if (!edge) continue;
      const kd = Math.hypot(p.x - edge.point.x, p.y - edge.point.y);
      const lack = half - kd;
      const beyond = !walking.onPaving(from.way.structure, p);
      if (lack <= 0 && !beyond) continue;
      // Towards the kerb: away from the outer edge.
      const ax = p.x - edge.point.x, ay = p.y - edge.point.y, al = Math.hypot(ax, ay) || 1;
      const dir = beyond ? { x: -ax / al, y: -ay / al } : { x: ax / al, y: ay / al };
      const move = beyond ? kd + half : lack;
      pts[q] = { x: p.x + dir.x * move, y: p.y + dir.y * move };
    }
    // Leaving each footway exactly along it: over the first and last stretch
    // the line eases from the footway's own straight run onto the contour,
    // so a hair's difference between the two (an offset polyline against a
    // rounded polygon offset) never shows as a kink.
    const total = pts.reduce((sum, p, q) => (q ? sum + Math.hypot(p.x - pts[q - 1]!.x, p.y - pts[q - 1]!.y) : 0), 0);
    const ease = Math.min(EASE, total / 3);
    let run = 0;
    const out = { x: -to.into.x, y: -to.into.y };
    const eased = pts.map((p, q) => {
      if (q) run += Math.hypot(p.x - pts[q - 1]!.x, p.y - pts[q - 1]!.y);
      const fromStart = run, fromEnd = total - run;
      if (fromStart < ease) {
        const w = smooth(fromStart / ease);
        const line = { x: from.p.x + from.into.x * fromStart, y: from.p.y + from.into.y * fromStart };
        return { x: line.x + (p.x - line.x) * w, y: line.y + (p.y - line.y) * w };
      }
      if (fromEnd < ease) {
        const w = smooth(fromEnd / ease);
        const line = { x: to.p.x - out.x * fromEnd, y: to.p.y - out.y * fromEnd };
        return { x: line.x + (p.x - line.x) * w, y: line.y + (p.y - line.y) * w };
      }
      return p;
    });
    eased[0] = from.p;
    eased[count] = to.p;
    // A few passes of neighbour averaging, the ends and their first steps
    // held: the line's direction must not turn in one step anywhere, or a
    // walker off its centre is thrown sideways there.
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const prev = eased.map((p) => ({ x: p.x, y: p.y }));
      for (let q = 2; q < count - 1; q++) {
        eased[q] = { x: (prev[q - 1]!.x + 2 * prev[q]!.x + prev[q + 1]!.x) / 4, y: (prev[q - 1]!.y + 2 * prev[q]!.y + prev[q + 1]!.y) / 4 };
      }
    }
    // The first and last chord define the tangent seen by walkers. Blending
    // positions toward a tangent line does not constrain that chord: the
    // contour can still pull its first sample sideways by several degrees.
    if (count >= 3) {
      const first = Math.min(EASE / 3, Math.hypot(eased[1]!.x - from.p.x, eased[1]!.y - from.p.y));
      const last = Math.min(EASE / 3, Math.hypot(eased[count - 1]!.x - to.p.x, eased[count - 1]!.y - to.p.y));
      eased[1] = { x: from.p.x + from.into.x * first, y: from.p.y + from.into.y * first };
      eased[count - 1] = { x: to.p.x - out.x * last, y: to.p.y - out.y * last };
    } else {
      // At a sub-metre junction the sampled contour has only one interior
      // point. It cannot define both endpoint derivatives; use short tangent
      // chords before joining the two footway ends.
      const chord = Math.min(JOIN, Math.hypot(to.p.x - from.p.x, to.p.y - from.p.y) / 4);
      return Polyline.fromPoints([
        from.p,
        { x: from.p.x + from.into.x * chord, y: from.p.y + from.into.y * chord },
        { x: to.p.x - out.x * chord, y: to.p.y - out.y * chord },
        to.p,
      ]);
    }
    const clean = eased.filter((p, q) => q === 0 || Math.hypot(p.x - eased[q - 1]!.x, p.y - eased[q - 1]!.y) > 1e-6);
    return clean.length >= 2 ? Polyline.fromPoints(clean) : null;
  };
  const walking = new WalkingLines(net);
  const join = (from: FootwayEnd, to: FootwayEnd, nodeId: NodeId, kerb: Vec2 | null, drawn: Polyline | null = null): void => {
    joined.add(from.node); joined.add(to.node);
    const out = { x: -to.into.x, y: -to.into.y };
    // The corner keeps the kerb on the side it is on walking into the node
    // along `from`, and the narrower of the two footways' reaches.
    const inset = Math.min(from.inset, to.inset), outer = Math.min(from.outer, to.outer);
    const lo = from.kerbSide < 0 ? -inset : -outer, hi = from.kerbSide < 0 ? outer : inset;
    if (Math.hypot(from.p.x - to.p.x, from.p.y - to.p.y) < JOIN) {
      // The same point: the two footways simply meet (a road carried straight on).
      g.add({ kind: 'corner', path: Polyline.fromPoints([from.p, { x: from.p.x + out.x * JOIN, y: from.p.y + out.y * JOIN }]),
        width: hi - lo, lo, hi, kerb: from.kerbSide < 0 ? -1 : 1, node: nodeId, structure: from.way.structure, a: from.node, b: to.node });
      return;
    }
    // Concentric with the kerb return: the radius is the walking line's own
    // distance from the return's centre - less than the kerb's round the
    // inside of a corner, more round the outside of a bend.
    const radius = kerb ? Math.abs((kerb.x - from.p.x) * from.into.y - (kerb.y - from.p.y) * from.into.x) : 0;
    const path = drawn ?? cornerPath(from.p, from.into, to.p, out, radius);
    g.add({ kind: 'corner', path, width: hi - lo, lo, hi, kerb: from.kerbSide < 0 ? -1 : 1, node: nodeId,
      structure: from.way.structure, a: from.node, b: to.node });
  };
  for (const [nodeId, mine] of ends) {
    yield;
    const node = doc.requireNode(nodeId);
    const here = mine;
    const byLevel = net.junctions.get(nodeId);
    const junction = byLevel?.get(Level.Sidewalk);
    if (junction && junction.legs.length >= 2 && !junction.transition) {
      // Each leg's footway joins the next leg's round the node, in angular
      // order, whatever the angle between them (SUMO's netconvert,
      // `NBNode::buildWalkingAreas`: sidewalks are grouped by their order
      // round the junction, never by the angle). A shallow merge has no
      // carriageway corners (`junction/build.ts`, legs under 25 degrees
      // apart): read off them, none of its footways joined any other, and
      // everything beyond it was an island nobody could walk to.
      const pairs = junction.corners.length ? junction.corners
        : junction.legs.map((_, i) => ({ i, j: (i + 1) % junction.legs.length }));
      for (const corner of pairs) {
        const li = junction.legs[corner.i]!, lj = junction.legs[corner.j]!;
        // Leg i's LEFT boundary feeds the corner, leg j's RIGHT boundary leaves it.
        const from = sideOf(here, li.seg, node, li.nrm, 1);
        const to = sideOf(here, lj.seg, node, lj.nrm, -1);
        if (!from || !to || from === to) continue;
        const kerb = byLevel?.get(Level.Curb)?.corners.find((c) => c.i === corner.i && c.j === corner.j)?.fillet ?? null;
        join(from, to, nodeId, kerb?.c ?? null, roundCorner(from, to, here, walking));
      }
      continue;
    }
    // A node of two roads drawn as a taper or a bend, or not drawn at all:
    // each side's footway runs on into the other road's on the same side.
    if (node.incident.length === 2) {
      const [s0, s1] = node.incident as [SegmentId, SegmentId];
      for (const e0 of here.filter((e) => e.way.segment === s0)) {
        let best: FootwayEnd | null = null, bestD = Infinity;
        for (const e1 of here.filter((e) => e.way.segment === s1)) {
          const d = Math.hypot(e1.p.x - e0.p.x, e1.p.y - e0.p.y);
          if (d < bestD) { best = e1; bestD = d; }
        }
        if (best) join(e0, best, nodeId, null, roundCorner(e0, best, here, walking));
      }
    }
  }
  yield;
  // --- crossings: over the carriageway on each zebra
  for (const [nodeId, node] of doc.nodes) {
    if (node.incident.length < 2) continue;
    for (const segId of node.incident) {
      const d = net.crosswalkDistanceAt(segId, nodeId);
      if (d <= 0) continue;
      const seg = doc.requireSegment(segId);
      const ribbon = net.ribbons.get(segId);
      if (!ribbon) continue;
      const section = sectionOf(ribbon.road, seg.direction);
      if (!section.walkable) continue;
      const f = orientedPolyline(doc, seg, nodeId).sampleAt(d);
      // Looking away from the node: from `a` its left is the road's left, from `b` its right.
      const fromA = seg.a === nodeId;
      const midLeft = bandMid((fromA ? section.left : section.right).through);
      const midRight = bandMid((fromA ? section.right : section.left).through);
      const left = { x: f.p.x + f.n.x * midLeft, y: f.p.y + f.n.y * midLeft };
      const right = { x: f.p.x - f.n.x * midRight, y: f.p.y - f.n.y * midRight };
      // Each end lands on the walkway nearest it on its own side - this
      // road's footway or the corner beside it - split there.
      const a = landOn(g, left, segId, nodeId);
      const b = landOn(g, right, segId, nodeId);
      if (a === null || b === null || a === b) continue;
      const pa = g.nodes[a]!, pb = g.nodes[b]!;
      // As wide as the zebra painted.
      g.add({ kind: 'crossing', path: Polyline.fromPoints([pa, pb]), width: CROSSWALK_DEPTH, lo: -CROSSWALK_DEPTH / 2, hi: CROSSWALK_DEPTH / 2, kerb: 0,
        segment: segId, node: nodeId, structure: deckOf(doc, segId), a, b });
    }
  }
  // --- road ends: across the end of a road that leads nowhere, an unmarked
  // crossing joins its two footways, or each side of a street that ends would
  // be an island to whoever walks it (a cul-de-sac, a road off the map).
  for (const [nodeId, mine] of ends) {
    const end = doc.requireNode(nodeId);
    if (end.incident.length !== 1) continue;
    const here = mine;
    const left = here.find((e) => e.side > 0), right = here.find((e) => e.side < 0);
    if (!left || !right || left.way.structure !== right.way.structure || left.way.segment === undefined) continue;
    if (Math.hypot(left.p.x - right.p.x, left.p.y - right.p.y) < JOIN) continue;
    // A turning circle (docs/VIAS.md V8): its footway runs round it, and so
    // does the walk from one side of the street to the other - on the
    // footway's walking line, nobody crossing the circle's carriageway.
    if (end.end === 'bulb') {
      const offset = Math.abs((left.p.x - end.x) * -left.into.y + (left.p.y - end.y) * left.into.x);
      let line = bulbLine(doc, net.polylines, nodeId, offset);
      if (line) {
        const first = line[0]!, last = line[line.length - 1]!;
        if (Math.hypot(first.x - left.p.x, first.y - left.p.y) > Math.hypot(last.x - left.p.x, last.y - left.p.y)) line = [...line].reverse();
        const inset = Math.min(left.inset, right.inset), outer = Math.min(left.outer, right.outer);
        const lo = left.kerbSide < 0 ? -inset : -outer, hi = left.kerbSide < 0 ? outer : inset;
        g.add({ kind: 'corner', path: Polyline.fromPoints([left.p, ...line, right.p]), width: hi - lo, lo, hi,
          kerb: left.kerbSide < 0 ? -1 : 1, node: nodeId, structure: left.way.structure, a: left.node, b: right.node });
        continue;
      }
    }
    g.add({ kind: 'crossing', path: Polyline.fromPoints([left.p, right.p]), width: m(2), lo: -m(1), hi: m(1), kerb: 0,
      segment: left.way.segment, node: nodeId, structure: left.way.structure, a: left.node, b: right.node, unmarked: true });
  }
  return g;
}

/** The footway end of `seg` at this node on the given side of the leg (its normal `nrm`, sign +1 left). */
function sideOf(ends: readonly FootwayEnd[], seg: SegmentId, node: Vec2, nrm: Vec2, sign: 1 | -1): FootwayEnd | null {
  let best: FootwayEnd | null = null, bestSide = 0;
  for (const e of ends) {
    if (e.way.segment !== seg) continue;
    const side = ((e.p.x - node.x) * nrm.x + (e.p.y - node.y) * nrm.y) * sign;
    if (side > bestSide) { best = e; bestSide = side; }
  }
  return best;
}

/**
 * The node on the walkway nearest `p` among this road's footways and this
 * node's corners - split there - or null when none is near.
 */
function landOn(g: WalkGraph, p: Vec2, seg: SegmentId, node: NodeId): number | null {
  let best: { way: Walkway; s: number; distance: number } | null = null;
  for (const way of g.ways) {
    const mine = (way.kind === 'footway' && way.segment === seg) || (way.kind === 'corner' && way.node === node);
    if (!mine) continue;
    const c = way.path.closestPoint(p);
    if (!best || c.distance < best.distance) best = { way, s: c.s, distance: c.distance };
  }
  if (!best || best.distance > best.way.width / 2 + LAND_REACH) return null;
  return g.split(best.way, best.s);
}
