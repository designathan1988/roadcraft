import type { Vec2 } from './vec2';
import { segSeg } from './intersect';

/** How far apart two edges' boxes must be, world units, before they are taken not to meet: well over what `segSeg` rounds (~1e-11 at the map's coordinates), so no pair it would find meeting is left out. */
const BOX_GAP = 1e-6;

/** True when a closed polygon has no self-intersections. DO NOT test every pair of edges with `segSeg` (it makes vectors each call: 21 s of the tile workers' junction rings in an opening, wprof5): each edge's box once, `segSeg` only where two boxes meet; the same answer. */
export function isSimple(points: readonly Vec2[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  const x0 = new Float64Array(n), x1 = new Float64Array(n), y0 = new Float64Array(n), y1 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[i] as Vec2, b = points[(i + 1) % n] as Vec2;
    x0[i] = Math.min(a.x, b.x) - BOX_GAP; x1[i] = Math.max(a.x, b.x) + BOX_GAP;
    y0[i] = Math.min(a.y, b.y) - BOX_GAP; y1[i] = Math.max(a.y, b.y) + BOX_GAP;
  }
  for (let i = 0; i < n; i++) {
    const ax0 = x0[i]!, ax1 = x1[i]!, ay0 = y0[i]!, ay1 = y1[i]!;
    for (let j = i + 1; j < n; j++) {
      // Skip the shared-vertex neighbours of edge i.
      if ((j + 1) % n === i || j === (i + 1) % n) continue;
      if (x0[j]! > ax1 || x1[j]! < ax0 || y0[j]! > ay1 || y1[j]! < ay0) continue;
      if (segSeg(points[i] as Vec2, points[(i + 1) % n] as Vec2, points[j] as Vec2, points[(j + 1) % n] as Vec2)) return false;
    }
  }
  return true;
}

export function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i] as Vec2;
    const pj = points[j] as Vec2;
    a += pj.x * pi.y - pi.x * pj.y;
  }
  return a / 2;
}

/** Ray-casting containment test. Points exactly on an edge are unspecified. */
export function pointInPolygon(p: Vec2, points: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i] as Vec2;
    const pj = points[j] as Vec2;
    const straddles = pi.y > p.y !== pj.y > p.y;
    if (!straddles) continue;
    const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

/** Monotone-chain convex hull, wound to positive signed area. */
export function convexHull(input: readonly Vec2[]): Vec2[] {
  if (input.length < 4) return input.slice();
  const pts = input
    .slice()
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const turn = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      turn(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Vec2;
    while (
      upper.length >= 2 &&
      turn(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return signedArea(hull) >= 0 ? hull : hull.reverse();
}
