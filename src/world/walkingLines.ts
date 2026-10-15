import { EPS } from '@core/scalar';
import { Polyline } from '@core/polyline';
import { filletCorner } from '@core/fillet';
import { lineLine } from '@core/intersect';
import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { union, type MultiPoly } from '@core/clipper';
import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';
import { m, stepsIn } from './units';
import { Level, type SurfaceLevel } from './roadTypes';
import type { RoadStructure } from './structures';

/** THE WALKING LINES the walkways are drawn along (`walkways.ts`) */

/** A corner's curve leaves each footway along it for this share of the gap between the ends (fallback only). */
const TANGENT_SHARE = 0.4;
/** Points per fallback curve. */
const CURVE_STEPS = 10;
/** Tightest turn a walking line is given round a corner, u (1 m). */
const MIN_CORNER_R = m(1);
/** Passes of smoothing over a corner's line. */
const SMOOTH_PASSES = 3;
/** Length over which a corner eases off its footway's straight run onto the walking contour, u. */
const EASE = m(0.6);
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Ends of two footways at one road node closer than this are one point, u. */
export const JOIN = m(0.02);

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

/** The walking line round a corner: along the footway of one leg, round an arc, along the footway of the next */
export function cornerPath(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2, radius: number): Polyline {
  const meet = lineLine(p0, d0, p1, d1, 1e-6);
  // Parallel lines (a road carried straight on), or lines meeting behind either end: a smooth curve between the ends.
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

/** DO NOT merge the whole map's kerbs and paving for a corner (`levelPolygons`) */
export class LocalLines {
  private readonly cache = new Map<string, Polyline[]>();
  private readonly edges = new Map<string, Polyline[]>();
  private readonly pavings = new Map<string, MultiPoly>();
  constructor(private readonly ringsOf: RingsOf) {}

  /** The merged rings of a level on one deck, of the pieces in the box. */
  private polygons(level: SurfaceLevel, deck: RoadStructure): MultiPoly {
    return union(this.ringsOf(level, deck));
  }

  /** Everything paved for walking or driving on one deck, out to the footway's outer edge. */
  paving(deck: RoadStructure): MultiPoly {
    let known = this.pavings.get(deck);
    if (!known) {
      // The footway level alone: `surfaces` unions all four levels to hand back one.
      known = this.polygons(Level.Sidewalk, deck);
      this.pavings.set(deck, known);
    }
    return known;
  }

  /** The paving of a deck as point rings with their boxes, made once (`onPaving`). */
  private readonly pavingRings = new Map<string, { outer: PavingRing | null; holes: PavingRing[] }[]>();

  /** Whether a point is on the paving of a deck. */
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
  /** The nearest point of the footway's outer edge on one deck, as the nearest of `outer`'s lines' `closestPoint`s */
  nearestOuter(deck: RoadStructure, p: Vec2): { point: Vec2; distance: number } | null {
    let index = this.outerIndex.get(deck);
    if (!index) this.outerIndex.set(deck, index = new NearestEdge(this.outer(deck)));
    return index.nearest(p);
  }

  /** The footway's outer edge on one deck: the outline of the paving, as drawn. */
  outer(deck: RoadStructure): Polyline[] {
    const known = this.edges.get(deck);
    if (known) return known;
    const lines: Polyline[] = [];
    for (const poly of this.paving(deck)) for (const ring of poly) {
      if (ring.length >= 3) lines.push(Polyline.fromPoints([...ring.map(([x, y]) => ({ x: x!, y: y! })), { x: ring[0]![0]!, y: ring[0]![1]! }]));
    }
    this.edges.set(deck, lines);
    return lines;
  }

  at(deck: RoadStructure, inset: number): Polyline[] {
    const key = `${deck}:${inset.toFixed(4)}`;
    const known = this.cache.get(key);
    if (known) return known;
    const kerbs = this.polygons(Level.Curb, deck);
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

/** How far from a walking line two footway ends may lie, together, for a stretch of it to join them. */
const STRETCH_REACH = m(0.8);

/** The stretch of a closed walking line from the point nearest `from` to the point nearest `to` */
function stretch(lines: readonly Polyline[], from: Vec2, to: Vec2, avoid: readonly Vec2[]): Vec2[] | null {
  let line: Polyline | null = null, best = Infinity;
  for (const l of lines) {
    // A line whose box is no nearer the two ends than the best found, or than a stretch takes, holds no nearer one
    const box = l.bbox;
    const lower = Math.hypot(Math.max(box.minX - from.x, 0, from.x - box.maxX), Math.max(box.minY - from.y, 0, from.y - box.maxY))
      + Math.hypot(Math.max(box.minX - to.x, 0, to.x - box.maxX), Math.max(box.minY - to.y, 0, to.y - box.maxY));
    if (lower > Math.min(best, STRETCH_REACH) + 1e-9) continue;
    const a = l.closestPoint(from), b = l.closestPoint(to);
    if (a.distance + b.distance < best) { best = a.distance + b.distance; line = l; }
  }
  if (!line || best > STRETCH_REACH) return null;
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


/** The rings of a level on one deck round one node, before they are merged (`levelRingsOf` of the pieces in its box). */
export type RingsOf = (level: SurfaceLevel, deck: RoadStructure) => MultiPoly;

/** One footway's end at a road node, as a corner reads it: where, walking into the node which way, its inset and width, its deck. */
export interface CornerEnd {
  readonly p: Vec2;
  readonly into: Vec2;
  readonly inset: number;
  readonly width: number;
  readonly structure: RoadStructure;
}

/** The walking line round from one footway end to another, as drawn, or null; `avoid`: the other footway ends at the node. */
export function roundCorner(from: CornerEnd, to: CornerEnd, avoid: readonly Vec2[], lines: () => LocalLines): Polyline | null {
  if (from.structure !== to.structure) return null;
  const walking = lines();
  // The stretch round the corner at each footway's own inset
  const a = stretch(walking.at(from.structure, from.inset), from.p, to.p, avoid);
  const b = from.inset === to.inset ? a : stretch(walking.at(to.structure, to.inset), from.p, to.p, avoid);
  if (!a || !b) return null;
  const count = Math.max(a.length, b.length) - 1;
  const ra = resample(a, count), rb = resample(b, count);
  const pts: Vec2[] = [];
  for (let q = 0; q <= count; q++) {
    const u = q / count, w = u * u * (3 - 2 * u);
    pts.push({ x: ra[q]!.x + (rb[q]!.x - ra[q]!.x) * w, y: ra[q]!.y + (rb[q]!.y - ra[q]!.y) * w });
  }
  // Where the footway narrows below the walking line's inset
  for (let q = 1; q < count; q++) {
    const p = pts[q]!;
    const u = q / count, half = (from.width + (to.width - from.width) * u) / 2;
    const edge = walking.nearestOuter(from.structure, p);
    if (!edge) continue;
    const kd = Math.hypot(p.x - edge.point.x, p.y - edge.point.y);
    const lack = half - kd;
    const beyond = !walking.onPaving(from.structure, p);
    if (lack <= 0 && !beyond) continue;
    // Towards the kerb: away from the outer edge.
    const ax = p.x - edge.point.x, ay = p.y - edge.point.y, al = Math.hypot(ax, ay) || 1;
    const dir = beyond ? { x: -ax / al, y: -ay / al } : { x: ax / al, y: ay / al };
    const move = beyond ? kd + half : lack;
    pts[q] = { x: p.x + dir.x * move, y: p.y + dir.y * move };
  }
  // Leaving each footway exactly along it
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
  // A few passes of neighbour averaging, the ends and their first steps held
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const prev = eased.map((p) => ({ x: p.x, y: p.y }));
    for (let q = 2; q < count - 1; q++) {
      eased[q] = { x: (prev[q - 1]!.x + 2 * prev[q]!.x + prev[q + 1]!.x) / 4, y: (prev[q - 1]!.y + 2 * prev[q]!.y + prev[q + 1]!.y) / 4 };
    }
  }
  // The first and last chord define the tangent seen by walkers.
  if (count >= 3) {
    const first = Math.min(EASE / 3, Math.hypot(eased[1]!.x - from.p.x, eased[1]!.y - from.p.y));
    const last = Math.min(EASE / 3, Math.hypot(eased[count - 1]!.x - to.p.x, eased[count - 1]!.y - to.p.y));
    eased[1] = { x: from.p.x + from.into.x * first, y: from.p.y + from.into.y * first };
    eased[count - 1] = { x: to.p.x - out.x * last, y: to.p.y - out.y * last };
  } else {
    // At a sub-metre junction the sampled contour has only one interior point.
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
}


/** The corners of one road node to round (`roundCorner`), as plain numbers for a worker (`conflictPool.ts`) */
export interface CornerAsk {
  readonly rings: readonly { readonly level: SurfaceLevel; readonly deck: RoadStructure; readonly polys: readonly (readonly Float64Array[])[] }[];
  readonly corners: readonly { readonly from: CornerEnd; readonly to: CornerEnd; readonly avoid: readonly Vec2[] }[];
}

/** Rounds many nodes' corners somewhere else */
export interface CornerMeasurer {
  roundCorners?(asks: readonly CornerAsk[]): Promise<readonly (readonly (Float64Array | null)[])[]>;
}

/** A node's rings as an ask carries them: each ring's points as one flat x, y list. */
export function flatRings(polys: MultiPoly): Float64Array[][] {
  return polys.map((poly) => poly.map((ring) => {
    const xy = new Float64Array(ring.length * 2);
    ring.forEach(([x, y], k) => { xy[k * 2] = x!; xy[k * 2 + 1] = y!; });
    return xy;
  }));
}

/** Each corner of an ask rounded as `roundCorner` rounds it on the page, from the same rings: its line's points, or null. */
export function roundCorners(ask: CornerAsk): (Float64Array | null)[] {
  const byLevel = new Map(ask.rings.map((r) => [`${r.level}:${r.deck}`, r.polys]));
  const lines = new LocalLines((level, deck) => (byLevel.get(`${level}:${deck}`) ?? []).map((poly) => poly.map((xy) => {
    const ring: number[][] = [];
    for (let k = 0; k + 1 < xy.length; k += 2) ring.push([xy[k]!, xy[k + 1]!]);
    return ring;
  })));
  return ask.corners.map((c) => roundCorner(c.from, c.to, c.avoid, () => lines)?.xy ?? null);
}
