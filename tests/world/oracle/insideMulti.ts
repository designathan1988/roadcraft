import type { Vec2 } from '@core/vec2';
import type { MultiPoly } from '@core/clipper';
import { m } from '@world/units';

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
