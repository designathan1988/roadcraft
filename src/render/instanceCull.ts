import type { Frustum } from 'three';

/** DO NOT bring back a cull that is made for the whole map at once. */

export type Bounds = { x: number; y: number; z: number; r: number };

/** The smallest sphere round two spheres. */
export function enclose(a: Bounds | null, b: Bounds): Bounds {
  if (!a || a.r < 0) return b;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  if (d + b.r <= a.r) return a;
  if (d + a.r <= b.r) return b;
  const r = (d + a.r + b.r) / 2, k = d > 0 ? (r - a.r) / d : 0;
  return { x: a.x + dx * k, y: a.y + dy * k, z: a.z + dz * k, r };
}

/** `a` grown in place to hold the sphere (x, y, z, r): `enclose` without a new object (the cull's tree grows thousands of spheres a pass). */
export function growInto(a: Bounds, x: number, y: number, z: number, r: number): void {
  if (a.r < 0) { a.x = x; a.y = y; a.z = z; a.r = r; return; }
  const dx = x - a.x, dy = y - a.y, dz = z - a.z, d = Math.hypot(dx, dy, dz);
  if (d + r <= a.r) return;
  if (d + a.r <= r) { a.x = x; a.y = y; a.z = z; a.r = r; return; }
  const nr = (d + a.r + r) / 2, k = d > 0 ? (nr - a.r) / d : 0;
  a.x += dx * k; a.y += dy * k; a.z += dz * k; a.r = nr;
}

/** The planes of `mask` (bit p: plane p not yet known to hold the sphere inside) against the sphere */
export function planeMask(frustum: Frustum, x: number, y: number, z: number, r: number, mask: number): number {
  let out = 0;
  for (let p = 0; p < 6; p++) {
    const bit = 1 << p;
    if ((mask & bit) === 0) continue;
    const plane = frustum.planes[p]!, n = plane.normal;
    const d = n.x * x + n.y * y + n.z * z + plane.constant;
    if (d < -r) return -1;
    if (d < r) out |= bit;
  }
  return out;
}

