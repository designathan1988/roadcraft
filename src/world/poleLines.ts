import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';

import { Polyline } from '@core/polyline';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { LAMP_ZONE } from './section';
import { crossingAccesses, crossingAccessesAt, type CrossingAccess } from './landscape';
import { levelPolygons, levelRingsOf } from './surfaces';
import { union } from '@core/clipper';
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
  const lines = { contours: contoursOf(kerbed), paving, kerbed, accesses: crossingAccesses(net) };
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
const regional = new WeakMap<Network, Map<string, Regional>>();
/**
 * Rectangles kept per network, the least recently asked let go first: the
 * runs being planned and the cell under the pointer. Kept up to a town's
 * every cell, the lines and their route graphs were 190 MB of a city of
 * 5 400 buildings and would be gigabytes on the whole map (2026-10-14);
 * only the pole tool reads them, a few cells at a time.
 * NÃO voltar a guardar a cidade inteira: a memória cresce com o mapa.
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
  let byRect = regional.get(net);
  if (!byRect) regional.set(net, byRect = new Map());
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
  const segments = new Set<SegmentId>(), nodes = new Set<NodeId>();
  for (const r of sources) {
    for (const id of net.segmentCells.idsMeeting(r)) segments.add(id);
    for (const id of net.junctionCells.idsMeeting(r)) nodes.add(id);
  }
  const ribbons: SegmentRibbon[] = [];
  const ends = new Set<NodeId>();
  for (const id of [...segments].sort((a, b) => a - b)) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) ribbons.push(ribbon);
    const segment = net.doc.segment(id);
    if (segment) { ends.add(segment.a); ends.add(segment.b); }
  }
  const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
  for (const id of [...nodes].sort((a, b) => a - b)) {
    const byLevel = net.junctions.get(id);
    if (byLevel) junctions.push([id, byLevel]);
  }
  const include = polesInclude(net);
  const kerbed = union(levelRingsOf(net, Level.Curb, ribbons, junctions, include));
  const paving = union(levelRingsOf(net, Level.Sidewalk, ribbons, junctions, include));
  const lines: PoleLines = {
    contours: contoursOf(kerbed), paving, kerbed,
    accesses: crossingAccessesAt(net, [...ends].sort((a, b) => a - b)),
  };
  if (byRect.size >= REGIONAL_KEPT) byRect.delete(byRect.keys().next().value!);
  byRect.set(key, { segmentEpoch, junctionEpoch, stamp, lines });
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

/** Whether a point is on a footway: on the paving, outside every kerbed carriageway. */
export function onFootway(net: Network, p: Vec2): boolean {
  const lines = poleLinesAt(net, p);
  return insideMulti(p, lines.paving) && !insideMulti(p, lines.kerbed);
}

/** Whether a point is on a kerbed carriageway (inside a kerb). */
export function onKerbed(net: Network, p: Vec2): boolean {
  return insideMulti(p, poleLinesAt(net, p).kerbed);
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
