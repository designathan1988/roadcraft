import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';

import { Polyline } from '@core/polyline';
import { EPS } from '@core/scalar';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { LAMP_ZONE } from './section';
import { crossingAccesses, crossingAccessesAt, type CrossingAccess } from './landscape';
import { levelPolygons, levelRingsOf } from './surfaces';
import { CLIPPER_SCALE, union } from '@core/clipper';
import { Level, type SurfaceLevel } from './roadTypes';
import type { NodeId, SegmentId } from './ids';
import { deckOf } from './walkways';
import { m } from './units';
import type { ChangeRect } from './changes';
import { cellAt, cellRect, grow } from './cells';
import type { Junction } from './junction/build';
import type { SegmentRibbon } from './network';

/**
 * The line wire poles stand on, and the kerb they stand behind.
 *
 * The outline of everything a kerb bounds (carriageway and kerb stone of
 * every ground street with footways, `surfaces().curb`), grown by
 * `POLE_KERB_INSET` with round joins (Clipper2, as the walking lines in
 * `walkways.ts` are). Each closed contour runs round one block at exactly that
 * distance from the kerb - along a street, round a corner's kerb return - so a
 * pole on it is on the pavement, never in a junction. The pole tool plans on
 * it (`editor/poles.ts`); the renderer turns a pole's lamp towards the kerb
 * nearest it (`kerbward`), which is right at a corner too, where no single
 * street owns the footway.
 */

/** How far behind the kerb stone the pole line runs: the middle of the lamp zone. */
export const POLE_KERB_INSET = LAMP_ZONE / 2;

export interface PoleLines {
  /** Closed contours, first point repeated at the end. */
  readonly contours: readonly Polyline[];
  /** The ground footways: paving out to the outer edge, and the kerbed carriageway inside it. */
  readonly paving: MultiPoly;
  readonly kerbed: MultiPoly;
  readonly accesses: readonly CrossingAccess[];
  /** The contours' edges filed by place (`nearestOnContour`). */
  readonly edges: ContourEdges;
}

/** The edges of a set of contours filed by place: each edge (contour, index) in every bucket its bounds reach. */
export interface ContourEdges { readonly buckets: ReadonlyMap<number, readonly number[]> }
/** Bucket edge of the contour index, world units: about the reach of the questions asked of it. */
const EDGE_BUCKET = m(8);
const edgeBucket = (bx: number, by: number): number => (bx + 1048576) * 2097152 + (by + 1048576);

function contourEdges(contours: readonly Polyline[]): ContourEdges {
  const buckets = new Map<number, number[]>();
  contours.forEach((line, contour) => {
    const xy = line.xy;
    for (let i = 0; i + 1 < line.n; i++) {
      const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, bx = xy[i * 2 + 2]!, by = xy[i * 2 + 3]!;
      for (let cx = Math.floor(Math.min(ax, bx) / EDGE_BUCKET); cx <= Math.floor(Math.max(ax, bx) / EDGE_BUCKET); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / EDGE_BUCKET); cy <= Math.floor(Math.max(ay, by) / EDGE_BUCKET); cy++) {
          const key = edgeBucket(cx, cy);
          const list = buckets.get(key);
          if (list) list.push(contour, i); else buckets.set(key, [contour, i]);
        }
      }
    }
  });
  return { buckets };
}

/** A place on a contour. */
export interface OnContour {
  readonly contour: number;
  readonly s: number;
  readonly at: Vec2;
  readonly distance: number;
}

/**
 * The nearest place on the lines' contours within `reach`, exactly as walking
 * every contour with `Polyline.closestPoint` answers it: per contour the first
 * edge at the least squared distance, then the first contour strictly nearer
 * than the ones before it. Only the edges filed near the point are measured
 * (`PoleLines.edges`): an edge within `reach` is always among them, and one
 * farther could never be the answer. Walking every edge of every contour was
 * the cost of the pole route graph's casts across the streets and grew with
 * the city (in a network of open streets the kerb line is one contour round
 * the whole town): 11.4 s of the generation of a city of radius 2,560 m.
 * DO NOT go back to scanning the contours: the question is local.
 */
export function nearestOnContour(lines: PoleLines, at: Vec2, reach: number): OnContour | null {
  const { buckets } = lines.edges;
  const px = at.x, py = at.y;
  // Per contour: the least squared distance found, the first edge giving it, and its parameter.
  const bestOf = new Map<number, { distSq: number; edge: number; t: number }>();
  for (let cx = Math.floor((px - reach) / EDGE_BUCKET); cx <= Math.floor((px + reach) / EDGE_BUCKET); cx++) {
    for (let cy = Math.floor((py - reach) / EDGE_BUCKET); cy <= Math.floor((py + reach) / EDGE_BUCKET); cy++) {
      const list = buckets.get(edgeBucket(cx, cy));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const contour = list[k]!, i = list[k + 1]!;
        const xy = lines.contours[contour]!.xy;
        // The arithmetic of `Polyline.nearestSegment`, in its order, so the answer is the same bit for bit.
        const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!;
        const abx = xy[i * 2 + 2]! - ax, aby = xy[i * 2 + 3]! - ay;
        const l2 = abx * abx + aby * aby;
        let t = 0, qx = ax, qy = ay;
        if (l2 >= EPS) {
          t = ((px - ax) * abx + (py - ay) * aby) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          qx = ax + abx * t;
          qy = ay + aby * t;
        }
        const ex = px - qx, ey = py - qy;
        const distSq = ex * ex + ey * ey;
        const was = bestOf.get(contour);
        if (!was || distSq < was.distSq || (distSq === was.distSq && i < was.edge)) bestOf.set(contour, { distSq, edge: i, t });
      }
    }
  }
  let best: OnContour | null = null;
  for (const contour of [...bestOf.keys()].sort((a, b) => a - b)) {
    const { distSq, edge, t } = bestOf.get(contour)!;
    const distance = Math.sqrt(distSq);
    if (distance > reach || (best && !(distance < best.distance))) continue;
    const line = lines.contours[contour]!;
    const xy = line.xy, cum = line.cum;
    const ax = xy[edge * 2]!, ay = xy[edge * 2 + 1]!;
    best = {
      contour,
      s: cum[edge]! + t * (cum[edge + 1]! - cum[edge]!),
      at: { x: ax + (xy[edge * 2 + 2]! - ax) * t, y: ay + (xy[edge * 2 + 3]! - ay) * t },
      distance,
    };
  }
  return best;
}

const cache = new WeakMap<Network, { revision: number; lines: PoleLines }>();

/** The streets whose kerb lines carry poles: ground streets with footways (the two levels read; `surfaces` unions all four). */
function polesInclude(net: Network): (id: SegmentId) => boolean {
  return (id) => {
    if (deckOf(net.doc, id) !== 'ground') return false;
    const ribbon = net.ribbons.get(id);
    return !!ribbon && carriesPedestrians(ribbon.road) && ribbon.road.sidewalk > 0;
  };
}

/** The contours of the kerb line round the kerbed polygons. */
function contoursOf(kerbed: MultiPoly): Polyline[] {
  const paths: PathsD = [];
  for (const poly of kerbed) for (const ring of poly) paths.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
  const contours: Polyline[] = [];
  if (paths.length) {
    const grown = inflatePathsD(unionD(paths, [], FillRule.NonZero, 3), POLE_KERB_INSET, JoinType.Round, EndType.Polygon, 2, 3, m(0.008));
    for (const ring of grown) if (ring.length >= 3) contours.push(Polyline.fromPoints([...ring, ring[0]!]));
  }
  return contours;
}

/**
 * The pole lines of the WHOLE map's ground streets that have footways, cached
 * per network revision: every road edit made them again for every street of
 * the map (33 ms of a road's click in a town of 237 buildings, 2026-10-11).
 * What asks about one place asks `poleLinesIn` / `poleLinesAt`, which read
 * only the cells round it; this stays as their oracle
 * (`tests/world/poleLinesCells.spec.ts`).
 */
export function poleLines(net: Network): PoleLines {
  const known = cache.get(net);
  if (known && known.revision === net.revision) return known.lines;
  const include = polesInclude(net);
  const kerbed = levelPolygons(net, Level.Curb, include);
  const paving = levelPolygons(net, Level.Sidewalk, include);
  const contours = contoursOf(kerbed);
  const lines = { contours, paving, kerbed, accesses: crossingAccesses(net), edges: contourEdges(contours) };
  cache.set(net, { revision: net.revision, lines });
  return lines;
}

/**
 * How far round a place its pole lines are made from: the farthest any
 * question about a point reaches (a footway snap, 12 m, `editor/poles.ts`)
 * plus the kerb-line inset, with room. A kerb line at a point depends only on
 * the kerbs within the inset of it (a union and an offset are local), so the
 * lines made from every ribbon and junction within this of a rectangle are
 * the whole map's lines inside it.
 */
const LINES_HALO = m(32);


/** What the regional pole lines did: made, kept, and the streets made from. A count for the budgets (`core/perfBudget.ts`). */
export const poleLinesWork = { made: 0, kept: 0, segments: 0 };

/** Regional lines of a network, by rectangle, with the cell versions they were made at. */
interface Regional {
  segmentEpoch: number;
  junctionEpoch: number;
  readonly stamp: string;
  readonly lines: PoleLines;
}
/** What is kept per network: the regional lines by rectangle, and each street's and junction's footway rings by the object the network built for it. */
interface NetworkLines { readonly regions: Map<string, Regional>; readonly rings: WeakMap<object, FootRings> }
const perNetwork = new WeakMap<Network, NetworkLines>();
function stateOf(net: Network): NetworkLines {
  let state = perNetwork.get(net);
  if (!state) perNetwork.set(net, state = { regions: new Map(), rings: new WeakMap() });
  return state;
}
/**
 * Rectangles kept per network, the least recently asked let go first: the
 * runs being planned and the cell under the pointer. Kept up to a town's
 * every cell, the lines and their route graphs were 190 MB of a city of
 * 5 400 buildings and would be gigabytes on the whole map (2026-10-14);
 * only the pole tool reads them, a few cells at a time.
 * DO NOT keep the whole city again: the memory grows with the map.
 */
const REGIONAL_KEPT = 64;

/**
 * The pole lines inside `rect`: the same lines `poleLines` has there, made
 * from the ribbons and junctions within `LINES_HALO` of it only
 * (`Network.segmentCells`), and kept while none of those cells moves. An
 * edit makes again only the rectangles it reached; the rest of the map is
 * not read. Its crossing landings are those of the nodes of its streets.
 */
export function poleLinesIn(net: Network, rect: ChangeRect): PoleLines {
  const byRect = stateOf(net).regions;
  const key = `${rect[0]},${rect[1]},${rect[2]},${rect[3]}`;
  const known = byRect.get(key);
  const segmentEpoch = net.segmentCells.epoch, junctionEpoch = net.junctionCells.epoch;
  // Asked again: to the back of the line, the last to be let go.
  if (known) { byRect.delete(key); byRect.set(key, known); }
  if (known && known.segmentEpoch === segmentEpoch && known.junctionEpoch === junctionEpoch) { poleLinesWork.kept++; return known.lines; }
  const sources = [grow(rect, LINES_HALO)];
  let stamp = '';
  for (const r of sources) stamp += `${net.segmentCells.stamp(r)}|${net.junctionCells.stamp(r)};`;
  if (known && known.stamp === stamp) {
    known.segmentEpoch = segmentEpoch;
    known.junctionEpoch = junctionEpoch;
    poleLinesWork.kept++;
    return known.lines;
  }
  const lines = poleLinesOf(net, rect);
  if (byRect.size >= REGIONAL_KEPT) byRect.delete(byRect.keys().next().value!);
  byRect.set(key, { segmentEpoch, junctionEpoch, stamp, lines });
  return lines;
}

/**
 * The pole lines inside `rect`, made now and not kept (`poleLinesIn` keeps
 * them): from the ribbons and junctions within `LINES_HALO` of it only.
 * Whoever plans many runs over one place (a generated city's power lines,
 * `editor/poles.ts` `poleRunPlanner`) makes them once and holds them.
 */
export function poleLinesOf(net: Network, rect: ChangeRect): PoleLines {
  const around = grow(rect, LINES_HALO);
  const segments = net.segmentCells.idsMeeting(around), nodes = net.junctionCells.idsMeeting(around);
  const ribbons: SegmentRibbon[] = [];
  const ends = new Set<NodeId>();
  for (const id of segments) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) ribbons.push(ribbon);
    const segment = net.doc.segment(id);
    if (segment) { ends.add(segment.a); ends.add(segment.b); }
  }
  const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
  for (const id of nodes) {
    const byLevel = net.junctions.get(id);
    if (byLevel) junctions.push([id, byLevel]);
  }
  const include = polesInclude(net);
  const kerbed = union(levelRingsOf(net, Level.Curb, ribbons, junctions, include));
  const paving = union(levelRingsOf(net, Level.Sidewalk, ribbons, junctions, include));
  const contours = contoursOf(kerbed);
  const lines: PoleLines = {
    contours, paving, kerbed, edges: contourEdges(contours),
    accesses: crossingAccessesAt(net, [...ends].sort((a, b) => a - b)),
  };
  poleLinesWork.made++;
  poleLinesWork.segments += ribbons.length;
  return lines;
}

/** The pole lines of the cell a point is in (`poleLinesIn`): right for any question reaching under `LINES_HALO - POLE_KERB_INSET` from it. */
export function poleLinesAt(net: Network, p: Vec2): PoleLines {
  return poleLinesIn(net, cellRect(cellAt(p.x, p.y)));
}

/**
 * A ring's edges filed by horizontal band: the crossing test of
 * `pointInPolygon` (the same arithmetic, so the same answer) on only the
 * edges at a point's height - the paving of a whole town is one polygon of
 * thousands of edges, and every point test walked all of them.
 */
interface BandedRing { readonly points: readonly Vec2[]; readonly bands: Map<number, number[]> }
const BAND = m(3.2);
function bandRing(points: readonly Vec2[]): BandedRing {
  const bands = new Map<number, number[]>();
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!.y, b = points[j]!.y;
    for (let k = Math.floor(Math.min(a, b) / BAND); k <= Math.floor(Math.max(a, b) / BAND); k++) {
      let list = bands.get(k);
      if (!list) bands.set(k, list = []);
      list.push(i);
    }
  }
  return { points, bands };
}
function insideRing(p: Vec2, ring: BandedRing): boolean {
  const edges = ring.bands.get(Math.floor(p.y / BAND));
  if (!edges) return false;
  const points = ring.points;
  let inside = false;
  for (const i of edges) {
    const pi = points[i]!;
    const pj = points[i === 0 ? points.length - 1 : i - 1]!;
    const straddles = pi.y > p.y !== pj.y > p.y;
    if (!straddles) continue;
    const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

/** One polygon of a MultiPoly ready to test against: its rings banded, and its bounds. */
interface IndexedPoly { readonly outer: BandedRing; readonly holes: BandedRing[]; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** A MultiPoly indexed for point tests: polygons by grid bucket. */
interface MultiIndex { readonly buckets: Map<number, IndexedPoly[]> }

/** Bucket edge of the point index, world units. */
const INDEX_CELL = m(25.6);
const bucketOf = (bx: number, by: number): number => (bx + 32768) * 65536 + (by + 32768);
const indexes = new WeakMap<MultiPoly, MultiIndex>();

/**
 * The polygons of a MultiPoly as points, bounded and bucketed, once per
 * MultiPoly (per network revision, as `poleLines` is cached): a point test
 * used to turn every polygon of the town into new point arrays and test them
 * all, for every point - the zoning grid asked millions, and an edit froze
 * the game for seconds (the profile of 2026-10-05).
 */
function indexOf(polys: MultiPoly): MultiIndex {
  const known = indexes.get(polys);
  if (known) return known;
  const buckets = new Map<number, IndexedPoly[]>();
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 3) continue;
    const ring = outer.map(([x, y]) => ({ x: x!, y: y! }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const indexed: IndexedPoly = { outer: bandRing(ring), holes: holes.map((h) => bandRing(h.map(([x, y]) => ({ x: x!, y: y! })))), x0, y0, x1, y1 };
    for (let bx = Math.floor(x0 / INDEX_CELL); bx <= Math.floor(x1 / INDEX_CELL); bx++) {
      for (let by = Math.floor(y0 / INDEX_CELL); by <= Math.floor(y1 / INDEX_CELL); by++) {
        const k = bucketOf(bx, by);
        let list = buckets.get(k);
        if (!list) buckets.set(k, list = []);
        list.push(indexed);
      }
    }
  }
  const index = { buckets };
  indexes.set(polys, index);
  return index;
}

/** Whether a point is inside a MultiPoly: inside a polygon's outer ring and none of its holes. */
export function insideMulti(p: Vec2, polys: MultiPoly): boolean {
  const list = indexOf(polys).buckets.get(bucketOf(Math.floor(p.x / INDEX_CELL), Math.floor(p.y / INDEX_CELL)));
  if (!list) return false;
  for (const poly of list) {
    if (p.x < poly.x0 || p.x > poly.x1 || p.y < poly.y0 || p.y > poly.y1) continue;
    if (!insideRing(p, poly.outer)) continue;
    if (poly.holes.some((h) => insideRing(p, h))) continue;
    return true;
  }
  return false;
}

/**
 * A ring as Clipper takes it in (`core/clipper.ts` `input`): its vertices on
 * Clipper's grid (in grid steps), a vertex repeating the one before dropped and
 * the closing repeat too, an outer ring turned to positive winding and a hole
 * to negative; with its bounds, in grid steps.
 */
interface WindingRing { readonly xy: Float64Array; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

function windingRings(polys: MultiPoly): WindingRing[] {
  const out: WindingRing[] = [];
  for (const poly of polys) {
    for (let k = 0; k < poly.length; k++) {
      const ring = poly[k]!;
      const pts: number[] = [];
      for (const pt of ring) {
        const x = Math.round(pt[0]! * CLIPPER_SCALE), y = Math.round(pt[1]! * CLIPPER_SCALE);
        const n = pts.length;
        if (n && pts[n - 2] === x && pts[n - 1] === y) continue;
        pts.push(x, y);
      }
      if (pts.length > 2 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
      if (pts.length < 6) continue;
      let area = 0;
      for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) area += pts[j]! * pts[i + 1]! - pts[i]! * pts[j + 1]!;
      // Positive for the outer ring, negative for a hole, whatever the order it was authored in.
      if ((area > 0) !== (k === 0)) {
        for (let a = 0, b = pts.length - 2; a < b; a += 2, b -= 2) {
          [pts[a], pts[b]] = [pts[b]!, pts[a]!];
          [pts[a + 1], pts[b + 1]] = [pts[b + 1]!, pts[a + 1]!];
        }
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!);
        y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!);
      }
      out.push({ xy: Float64Array.from(pts), x0, y0, x1, y1 });
    }
  }
  return out;
}

/** The winding number of a ring round a point, both in grid steps (Sunday's crossing rule: upward edges with the point on their left count +1, downward ones with it on their right -1). */
function windingOf(ring: WindingRing, x: number, y: number): number {
  const xy = ring.xy;
  let wn = 0;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const ax = xy[j]!, ay = xy[j + 1]!, bx = xy[i]!, by = xy[i + 1]!;
    if (ay <= y) {
      if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wn++;
    } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) wn--;
  }
  return wn;
}

/** The footway and kerb rings of a street or a junction (`NetworkLines.rings`): made again with the object the network builds for it. */
interface FootRings { readonly paving: WindingRing[]; readonly kerbed: WindingRing[] }

/**
 * Whether a point is inside the union of a level's rings of the streets with
 * footways round it: the union is NonZero (`core/clipper.ts`), so the point is
 * in it exactly when the windings of the rings round it add up to anything
 * but 0 - asked of the rings of the streets and junctions filed over the
 * point, with no union made. The question used to make the union and the
 * kerb-line offset of every street round the point's cell (Clipper) just to
 * answer it, and to throw that away again from a cache of 64 regions shared
 * with the pole runs: on a city of radius 2,560 m it was 17.6 s of the
 * generation, growing faster than the city.
 * DO NOT answer a point from a region's union again: the answer is local.
 */
function insideLevels(net: Network, p: Vec2): { readonly paving: boolean; readonly kerbed: boolean } {
  const x = p.x * CLIPPER_SCALE, y = p.y * CLIPPER_SCALE;
  let paving = 0, kerbed = 0;
  for (const rings of localRings(net, [p.x, p.y, p.x, p.y])) {
    for (const r of rings.paving) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) paving += windingOf(r, x, y);
    for (const r of rings.kerbed) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) kerbed += windingOf(r, x, y);
  }
  return { paving: paving !== 0, kerbed: kerbed !== 0 };
}

/** The footway and kerb rings of the streets with footways and their junctions filed over `rect`, each made once per object the network built. */
function localRings(net: Network, rect: ChangeRect): FootRings[] {
  const include = polesInclude(net);
  const footRings = stateOf(net).rings;
  const out: FootRings[] = [];
  for (const id of net.segmentCells.idsMeeting(rect)) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) continue;
    let rings = footRings.get(ribbon);
    if (!rings) {
      rings = {
        paving: windingRings(levelRingsOf(net, Level.Sidewalk, [ribbon], [], include)),
        kerbed: windingRings(levelRingsOf(net, Level.Curb, [ribbon], [], include)),
      };
      footRings.set(ribbon, rings);
    }
    out.push(rings);
  }
  for (const id of net.junctionCells.idsMeeting(rect)) {
    const byLevel = net.junctions.get(id);
    if (!byLevel) continue;
    let rings = footRings.get(byLevel);
    if (!rings) {
      rings = {
        paving: windingRings(levelRingsOf(net, Level.Sidewalk, [], [[id, byLevel]], include)),
        kerbed: windingRings(levelRingsOf(net, Level.Curb, [], [[id, byLevel]], include)),
      };
      footRings.set(byLevel, rings);
    }
    out.push(rings);
  }
  return out;
}

/** Whether a point is on a footway: on the paving, outside every kerbed carriageway. */
export function onFootway(net: Network, p: Vec2): boolean {
  const inside = insideLevels(net, p);
  return inside.paving && !inside.kerbed;
}

/** Whether a point is on a kerbed carriageway (inside a kerb). */
export function onKerbed(net: Network, p: Vec2): boolean {
  return insideLevels(net, p).kerbed;
}

/** The work `kerbward` did: kerb edges walked. A count for the performance budgets (`core/perfBudget.ts`). */
export const kerbWork = { edges: 0 };

/** Each ring's bounds of a MultiPoly, in its order, made once per MultiPoly (`kerbward`). */
const boxesOf = new WeakMap<MultiPoly, readonly (readonly [number, number, number, number])[]>();
function ringBoxes(polys: MultiPoly): readonly (readonly [number, number, number, number])[] {
  const known = boxesOf.get(polys);
  if (known) return known;
  const out: [number, number, number, number][] = [];
  for (const poly of polys) for (const ring of poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pt of ring) { x0 = Math.min(x0, pt[0]!); y0 = Math.min(y0, pt[1]!); x1 = Math.max(x1, pt[0]!); y1 = Math.max(y1, pt[1]!); }
    out.push([x0, y0, x1, y1]);
  }
  boxesOf.set(polys, out);
  return out;
}

/**
 * The unit direction from a point to the nearest kerb edge (the carriageway's
 * side), or null when no kerbed street is within `reach`.
 */
export function kerbward(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  // As far as the cell's lines would answer (`poleLinesAt`, within their halo).
  let bestD = Math.min(reach, LINES_HALO - POLE_KERB_INSET);
  const rings = localRings(net, [p.x - bestD, p.y - bestD, p.x + bestD, p.y + bestD]);
  const x = p.x * CLIPPER_SCALE, y = p.y * CLIPPER_SCALE;
  let winding = 0;
  for (const set of rings) for (const r of set.kerbed) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) winding += windingOf(r, x, y);
  // Inside the carriageway the union has no edge where two kerbs overlap, so the rings' nearest edge is not its: asked of the union there.
  if (winding !== 0) return kerbwardOfUnion(net, p, reach);
  /**
   * Outside every kerb (where a pole stands), the nearest point of the
   * kerbs' union is the nearest point of the nearest ring: a nearer one would
   * lie inside another ring, whose edge would be nearer still. So the
   * kerbs are read from the rings of the streets round the point, with the
   * union's arithmetic (Clipper's grid) and its tie rule. Every pole of the
   * map asked its cell's union (Clipper) after any road edit, through a
   * cache of 64 cells: on a city each edit made the cells again one after
   * another.
   * DO NOT ask a pole's kerb of a region's union again: the answer is local.
   */
  const reachSq = (bestD * CLIPPER_SCALE) ** 2;
  for (const set of rings) {
    for (const r of set.kerbed) {
      const bx = Math.max(r.x0 - x, 0, x - r.x1), by = Math.max(r.y0 - y, 0, y - r.y1);
      if (bx * bx + by * by > reachSq * (1 + 1e-9) + 1) continue;
      const xy = r.xy;
      kerbWork.edges += xy.length / 2;
      for (let i = 0; i < xy.length; i += 2) {
        const j = (i + 2) % xy.length;
        const ax = xy[i]! / CLIPPER_SCALE, ay = xy[i + 1]! / CLIPPER_SCALE;
        const dx = xy[j]! / CLIPPER_SCALE - ax, dy = xy[j + 1]! / CLIPPER_SCALE - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d <= 1e-9 || d > bestD + 1e-9) continue;
        const ux = qx / d, uy = qy / d;
        if (best && d >= bestD - 1e-9 && (ux < best.x || (ux === best.x && uy <= best.y))) continue;
        bestD = Math.min(bestD, d);
        best = { x: ux, y: uy };
      }
    }
  }
  return best;
}

/** `kerbward` over the cell's union (`poleLinesAt`): for a point inside a kerb, where the union and the rings differ. */
function kerbwardOfUnion(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  // The cell's lines answer within their halo (`poleLinesAt`).
  let bestD = Math.min(reach, LINES_HALO - POLE_KERB_INSET);
  const kerbed = poleLinesAt(net, p).kerbed;
  const boxes = ringBoxes(kerbed);
  let r = 0;
  for (const poly of kerbed) {
    for (const ring of poly) {
      // A ring whose bounds are no nearer than the kerb found so far holds
      // no nearer edge (the bound's distance never exceeds the edge's): not
      // walked. Every pole of the town walked every kerb edge of the town,
      // on every road edit (90 ms of each on the player's map, 2026-10-11).
      const box = boxes[r++]!;
      if (Math.hypot(Math.max(box[0] - p.x, 0, p.x - box[2]), Math.max(box[1] - p.y, 0, p.y - box[3])) > bestD + 1e-6) continue;
      kerbWork.edges += ring.length;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const ax = a[0]!, ay = a[1]!, dx = b[0]! - ax, dy = b[1]! - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d <= 1e-9 || d > bestD + 1e-9) continue;
        // Two kerbs as near (a point on a street's middle line): the answer
        // must not hang on the order the rings come in - the cell's lines and
        // the whole map's list them differently - so the tie goes by direction.
        const x = qx / d, y = qy / d;
        if (best && d >= bestD - 1e-9 && (x < best.x || (x === best.x && y <= best.y))) continue;
        bestD = Math.min(bestD, d);
        best = { x, y };
      }
    }
  }
  return best;
}
