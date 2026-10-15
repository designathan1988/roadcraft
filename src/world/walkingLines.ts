import { EPS } from '@core/scalar';
import { Polyline } from '@core/polyline';
import { filletCorner } from '@core/fillet';
import { lineLine } from '@core/intersect';
import type { Vec2 } from '@core/vec2';
import { pointInPolygon } from '@core/polygon';
import { union, type MultiPoly } from '@core/clipper';
import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';
import type { SegmentId } from './ids';
import { m, stepsIn } from './units';
import type { Network } from './network';
import { Level, type SurfaceLevel } from './roadTypes';
import { levelRingsOf } from './surfaces';
import type { ChangeRect } from './changes';
import type { RoadStructure } from './structures';

/**
 * THE WALKING LINES the walkways are drawn along (`walkways.ts`): the contour
 * round the kerbs at a footway's inset, the paving's outer edge, and the
 * curves a corner falls back on.
 */

/** A corner's curve leaves each footway along it for this share of the gap between the ends (fallback only). */
const TANGENT_SHARE = 0.4;
/** Points per fallback curve. */
const CURVE_STEPS = 10;
/** Tightest turn a walking line is given round a corner, u (1 m). */
const MIN_CORNER_R = m(1);

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
export function cornerPath(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2, radius: number): Polyline {
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

/**
 * The walking lines round one node, at one inset on one deck: the outline of
 * everything a kerb bounds (carriageway and kerb stone, as drawn), grown by
 * the inset. Each closed contour runs at exactly that distance from the
 * kerb's outer edge all the way round - along a road, round a junction's kerb
 * return, a bevelled sharp bend, the end of a hairpin - which is what a
 * walking line is. Polygon offsetting (Clipper2) does it for any shape the
 * junction builder and the road ribbons draw together; the junction's own
 * ring alone does not (it cuts the outside of a sharp bend straight across
 * the road).
 *
 * Made from the ribbons and junction plates filed in the node's box
 * (`Network.ribbonsMeeting`, `junctionCells`): an outline within the box is
 * the same whether the pieces beyond it are merged in or not, as a piece
 * meets the box or adds nothing inside it, and the box reaches the inset
 * beyond everything asked. DO NOT merge the whole map's kerbs and paving for
 * a corner (`levelPolygons`): every road drawn merged the town's again, and
 * every corner read the town's outline (SUMO builds each junction's walking
 * areas from that junction's own sidewalks and crossings,
 * sumo.dlr.de/docs/Simulation/Pedestrians.html).
 */
export class LocalLines {
  private readonly cache = new Map<string, Polyline[]>();
  private readonly edges = new Map<string, Polyline[]>();
  private readonly pavings = new Map<string, MultiPoly>();
  /** `deckOf`: the deck a road's footways belong to (`walkways.ts`). */
  constructor(private readonly net: Network, private readonly rect: ChangeRect, private readonly deckOf: (id: SegmentId) => RoadStructure) {}

  /** The merged rings of a level on one deck, of the pieces in the box. */
  private polygons(level: SurfaceLevel, deck: RoadStructure): MultiPoly {
    const net = this.net;
    const junctions = net.junctionCells.idsMeeting(this.rect).flatMap((id) => {
      const at = net.junctions.get(id);
      return at ? [[id, at] as const] : [];
    });
    return union(levelRingsOf(net, level, net.ribbonsMeeting(this.rect), junctions, (id) => this.deckOf(id) === deck));
  }

  /** Everything paved for walking or driving on one deck, out to the footway's outer edge. */
  paving(deck: RoadStructure): MultiPoly {
    let known = this.pavings.get(deck);
    if (!known) {
      // The footway level alone: `surfaces` unions all four levels to hand back one (docs/performance.md #11).
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
  /**
   * The nearest point of the footway's outer edge on one deck, as the nearest
   * of `outer`'s lines' `closestPoint`s (earlier lines and pieces win ties),
   * read off a grid (docs/performance.md #11).
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
export function resample(points: readonly Vec2[], count: number): Vec2[] {
  const line = Polyline.fromPoints(points.filter((p, q) => q === 0 || Math.hypot(p.x - points[q - 1]!.x, p.y - points[q - 1]!.y) > 1e-9));
  const out: Vec2[] = [];
  for (let q = 0; q <= count; q++) out.push(line.sampleAt((line.length * q) / count).p);
  return out;
}

/** How far from a walking line two footway ends may lie, together, for a stretch of it to join them. */
const STRETCH_REACH = m(0.8);

/**
 * The stretch of a closed walking line from the point nearest `from` to the
 * point nearest `to`, going the way that passes none of `avoid` (the other
 * footway ends at the junction). Null when the two ends are not on one line.
 */
export function stretch(lines: readonly Polyline[], from: Vec2, to: Vec2, avoid: readonly Vec2[]): Vec2[] | null {
  let line: Polyline | null = null, best = Infinity;
  for (const l of lines) {
    // A line whose box is no nearer the two ends than the best found, or than
    // a stretch takes, holds no nearer one: not walked (the box's MINDIST is
    // a lower bound, Roussopoulos et al. 1995). Every corner of the town read
    // every walking line of the town - 8.6 s of a 2 560 m town (2026-10-14).
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

