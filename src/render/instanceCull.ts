import type { Frustum, InstancedBufferAttribute } from 'three';

/**
 * WHAT EVERY INSTANCE CULL BY CELLS OF THE GROUND SHARES: the sphere round
 * two spheres, a sphere against the frustum's planes still unsettled (the
 * plane masks of bvh.js `BVH.frustumCulling`, what InstancedMesh2 culls
 * with), and one pending upload range per attribute. The culls themselves
 * keep their instances thing by thing in a quadtree they grow as things come
 * (`instanceRuns.ts`, `gardens.ts`).
 *
 * The static tree that was here (`createInstanceCull`, `spatialOrder`: every
 * instance of a layer sorted and filed once per build) needed the whole layer
 * built again for one thing changed; its last user, the street furniture,
 * keeps its items as runs now (`instanceRuns.ts`). DO NOT bring back a cull
 * that is made for the whole map at once.
 */

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

/**
 * The planes of `mask` (bit p: plane p not yet known to hold the sphere
 * inside) against the sphere: -1 when it lies wholly outside one of them,
 * else the planes it straddles - 0 when it is wholly inside every one. The
 * same sum as three's `Plane.distanceToPoint` in `Frustum.intersectsSphere`.
 */
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

/**
 * A changed run of an attribute to upload, kept as ONE pending range: three
 * clears the ranges only when it uploads (`WebGLAttributes.updateBuffer`),
 * and a mesh not drawn would pile one up per cull.
 */
export function markRange(attribute: InstancedBufferAttribute, start: number, count: number): void {
  const pending = attribute.updateRanges[0];
  if (!pending) attribute.addUpdateRange(start, count);
  else {
    const end = Math.max(pending.start + pending.count, start + count);
    pending.start = Math.min(pending.start, start);
    pending.count = end - pending.start;
  }
  attribute.needsUpdate = true;
}

