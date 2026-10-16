import type { Frustum } from 'three';
import type { GroundBox } from '@sim/host/fleetGrid';

/** THE VIEW'S GROUND: the box on the ground under what a frustum can see between two heights */

/** The frustum's corners (one plane of each pair met: right/left, bottom/top, far/near), written in place. */
const xs = new Float64Array(8), ys = new Float64Array(8), zs = new Float64Array(8);
/** The hexahedron's twelve edges: the corners that differ in one plane. */
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * The ground box (world x, y = three's -z) of the frustum with each plane pushed out by `grow`, cut between the heights
 * `low` and `high`: every centre a sphere of radius `grow` may stand at and pass `Frustum.intersectsSphere` stands in it.
 * The cut's corners are the frustum's corners between the heights and its edges' crossings of them; an empty cut, an empty box.
 */
export function frustumGroundBox(frustum: Frustum, grow: number, low: number, high: number, out: GroundBox): GroundBox {
  const planes = frustum.planes;
  for (let k = 0; k < 8; k++) {
    const a = planes[k & 1]!, b = planes[2 + ((k >> 1) & 1)]!, c = planes[4 + ((k >> 2) & 1)]!;
    const n1 = a.normal, n2 = b.normal, n3 = c.normal;
    // Three planes n . p + d = 0 (`Plane.constant`), pushed out: d + grow.
    const d1 = a.constant + grow, d2 = b.constant + grow, d3 = c.constant + grow;
    const ax = n2.y * n3.z - n2.z * n3.y, ay = n2.z * n3.x - n2.x * n3.z, az = n2.x * n3.y - n2.y * n3.x;
    const bx = n3.y * n1.z - n3.z * n1.y, by = n3.z * n1.x - n3.x * n1.z, bz = n3.x * n1.y - n3.y * n1.x;
    const cx = n1.y * n2.z - n1.z * n2.y, cy = n1.z * n2.x - n1.x * n2.z, cz = n1.x * n2.y - n1.y * n2.x;
    const det = n1.x * ax + n1.y * ay + n1.z * az;
    xs[k] = -(d1 * ax + d2 * bx + d3 * cx) / det;
    ys[k] = -(d1 * ay + d2 * by + d3 * cy) / det;
    zs[k] = -(d1 * az + d2 * bz + d3 * cz) / det;
  }
  out.x0 = Infinity; out.y0 = Infinity; out.x1 = -Infinity; out.y1 = -Infinity;
  for (let k = 0; k < 8; k++) if (ys[k]! >= low && ys[k]! <= high) take(out, xs[k]!, zs[k]!);
  for (const [i, j] of EDGES) {
    cross(out, i, j, low);
    cross(out, i, j, high);
  }
  return out;
}

/** Where the edge from corner `i` to `j` crosses the height `h`, taken (nothing where it does not cross). */
function cross(out: GroundBox, i: number, j: number, h: number): void {
  const yi = ys[i]!, yj = ys[j]!;
  if ((yi - h) * (yj - h) >= 0) return;
  const t = (h - yi) / (yj - yi);
  take(out, xs[i]! + (xs[j]! - xs[i]!) * t, zs[i]! + (zs[j]! - zs[i]!) * t);
}

function take(out: GroundBox, x: number, z: number): void {
  if (x < out.x0) out.x0 = x;
  if (x > out.x1) out.x1 = x;
  if (-z < out.y0) out.y0 = -z;
  if (-z > out.y1) out.y1 = -z;
}
