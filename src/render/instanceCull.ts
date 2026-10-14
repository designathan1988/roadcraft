import { Sphere, type Frustum, type InstancedBufferAttribute, type InstancedMesh } from 'three';
import { m } from '@world/units';

/**
 * CULLING INSTANCES BY CELLS OF THE GROUND, NOT ONE BY ONE.
 *
 * A layer of instanced meshes spread over the whole town (the street
 * furniture: lamps, bins, street trees, shrubs...) keeps only the instances
 * the camera can see. The old cull (`scenery.ts` `cullInstances`) tested
 * EVERY instance of the town against the frustum at every camera move - the
 * sphere round a whole mesh spans the town, so it almost never rejected
 * anything - and uploaded the whole drawn prefix again: a cost per move that
 * grew with the town's area.
 *
 * Here every instance is filed in a leaf cell of a sparse quadtree over the
 * ground (leaves of `CULL_CELL`), each node holding the sphere round
 * everything under it, and the cull walks the tree with the plane masks of
 * bvh.js `BVH.frustumCulling` (what InstancedMesh2 culls with): a node
 * outside one plane is dropped with all it holds, a node wholly inside every
 * plane is taken without testing anything under it, and only the leaves
 * across the view's edge test their instances one by one, with the same
 * `Frustum.intersectsSphere` as ever. The instances of each mesh are stored
 * in the order the walk visits the cells (`spatialOrder`), so everything
 * under a node is ONE contiguous run of each mesh, and the instances drawn
 * come out in ascending order - exactly the list the old per-instance pass
 * made. Only the positions that now hold another instance are written, and
 * only their range goes to the GPU (`BufferAttribute.addUpdateRange`).
 *
 * DO NOT go back to a pass over every instance of the town per camera move,
 * nor to a flat list of cells (it grows with the town's area too), nor to
 * uploading the whole drawn prefix at every cull.
 */

/** Every instance of one mesh, in `spatialOrder`, kept apart from what is drawn. */
export interface CulledInstances {
  /** Per instance: its matrix, as `instanceMatrix` holds it. */
  readonly matrices: Float32Array;
  /** Per instance: its tint, as `instanceColor` holds it; null when the mesh has none. */
  readonly colours: Float32Array | null;
  /** Per instance: centre x, y, z and radius, in the scene's frame. */
  readonly spheres: Float32Array;
  readonly count: number;
}

/** Side of a leaf cell. */
export const CULL_CELL = m(64);
/** Levels above the leaves: a root spans CULL_CELL * 2^CULL_LEVELS (65 km), so a town of any size has a handful of roots. */
export const CULL_LEVELS = 10;
const LOCAL = (1 << CULL_LEVELS) - 1;
/** Slack on a node's radius over float rounding: a node test may only keep more than its instances' tests would, never less. */
const PAD = m(0.001);
/** Every frustum plane still to test. */
const ALL_PLANES = 0b111111;

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

/** Interleaves a cell's low bits, x in the even bits: the order the walk visits a root's leaves (quadrant = x bit | z bit << 1). */
function morton(lx: number, lz: number): number {
  let code = 0;
  for (let b = 0; b < CULL_LEVELS; b++) code |= (((lx >> b) & 1) << (2 * b)) | (((lz >> b) & 1) << (2 * b + 1));
  return code;
}

/** Per instance: its root cell (x, z) and its leaf's place in the root's walk. */
function cellKeys(spheres: Float32Array, count: number): { rx: Int32Array; rz: Int32Array; code: Int32Array } {
  const rx = new Int32Array(count), rz = new Int32Array(count), code = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    // Scene z is the world's -y: the cell is found on the ground plane, x and z.
    const ix = Math.floor(spheres[i * 4]! / CULL_CELL), iz = Math.floor(spheres[i * 4 + 2]! / CULL_CELL);
    rx[i] = ix >> CULL_LEVELS;
    rz[i] = iz >> CULL_LEVELS;
    code[i] = morton(ix & LOCAL, iz & LOCAL);
  }
  return { rx, rz, code };
}

/**
 * The order to store instances in, from their spheres (`CulledInstances.spheres`):
 * by root cell (x, then z), then by the walk's order of the leaves under it,
 * then as given. `order[k]` is the instance to put at position k.
 */
export function spatialOrder(spheres: Float32Array, count: number): Int32Array {
  const { rx, rz, code } = cellKeys(spheres, count);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  return order.sort((a, b) => (rx[a]! - rx[b]!) || (rz[a]! - rz[b]!) || (code[a]! - code[b]!) || (a - b));
}

interface CullNode {
  /** Sphere round everything under it, scene frame. */
  readonly x: number; readonly y: number; readonly z: number; readonly r: number;
  /** Inner node: its non-empty quadrants, in quadrant order. Null for a leaf. */
  readonly children: readonly CullNode[] | null;
  /** Per mesh with instances under it: mesh index, first instance, end (exclusive) - one run, as the instances are in `spatialOrder`. */
  readonly spans: Int32Array;
}

interface Keys { readonly rx: Int32Array; readonly rz: Int32Array; readonly code: Int32Array }

/** The node over these runs of instances, `level` levels above the leaves. */
function nodeOver(sets: readonly CulledInstances[], keys: readonly Keys[], level: number, spans: readonly number[]): CullNode {
  if (level === 0) {
    let bounds: Bounds | null = null;
    for (let t = 0; t < spans.length; t += 3) {
      const sp = sets[spans[t]!]!.spheres;
      for (let i = spans[t + 1]!; i < spans[t + 2]!; i++) {
        bounds = enclose(bounds, { x: sp[i * 4]!, y: sp[i * 4 + 1]!, z: sp[i * 4 + 2]!, r: sp[i * 4 + 3]! });
      }
    }
    return { ...bounds!, children: null, spans: Int32Array.from(spans) };
  }
  // Each run split by the quadrant one level down: contiguous, the instances being in walk order.
  const quarters: number[][] = [[], [], [], []];
  const shift = 2 * (level - 1);
  for (let t = 0; t < spans.length; t += 3) {
    const k = spans[t]!, end = spans[t + 2]!, code = keys[k]!.code;
    let i = spans[t + 1]!;
    while (i < end) {
      const q = (code[i]! >> shift) & 3;
      const start = i;
      while (i < end && ((code[i]! >> shift) & 3) === q) i++;
      quarters[q]!.push(k, start, i);
    }
  }
  const children: CullNode[] = [];
  let bounds: Bounds | null = null;
  for (const quarter of quarters) {
    if (!quarter.length) continue;
    const child = nodeOver(sets, keys, level - 1, quarter);
    children.push(child);
    bounds = enclose(bounds, child);
  }
  return { x: bounds!.x, y: bounds!.y, z: bounds!.z, r: bounds!.r, children, spans: Int32Array.from(spans) };
}

/** The quadtree's roots over every mesh's instances, in the walk's order. */
function treeOver(sets: readonly CulledInstances[]): CullNode[] {
  const keys = sets.map((set) => cellKeys(set.spheres, set.count));
  const roots = new Map<string, { rx: number; rz: number; spans: number[] }>();
  sets.forEach((set, k) => {
    const { rx, rz, code } = keys[k]!;
    let i = 0;
    while (i < set.count) {
      const x = rx[i]!, z = rz[i]!, start = i;
      while (i < set.count && rx[i] === x && rz[i] === z) {
        // DO NOT drop this check: the runs and the order drawn rely on it.
        if (i > start && code[i]! < code[i - 1]!) throw new Error('instances not in spatialOrder');
        i++;
      }
      if (i < set.count && (rx[i]! < x || (rx[i] === x && rz[i]! < z))) throw new Error('instances not in spatialOrder');
      const key = `${x},${z}`;
      let root = roots.get(key);
      if (!root) roots.set(key, root = { rx: x, rz: z, spans: [] });
      root.spans.push(k, start, i);
    }
  });
  return [...roots.values()]
    .sort((a, b) => (a.rx - b.rx) || (a.rz - b.rz))
    .map((root) => nodeOver(sets, keys, CULL_LEVELS, root.spans));
}

export interface InstanceCull {
  /** The camera moved: every mesh is culled again when next asked for. */
  invalidate(): void;
  /**
   * The instances of each mesh `active` names (and not culled since the last
   * `invalidate`) the frustum can see, or see `margin` round, copied to the
   * front of its buffers, in their stored order. A mesh not active keeps its
   * buffers as they were until it is asked for again.
   */
  cull(frustum: Frustum, active: (index: number) => boolean): void;
}

/**
 * The cull over these meshes, each with every instance it holds (in
 * `spatialOrder`, and written in its buffers in that order when made).
 * `margin`: how far outside the view an instance is still drawn.
 */
export function createInstanceCull(entries: readonly { readonly mesh: InstancedMesh; readonly instances: CulledInstances }[], margin: number): InstanceCull {
  const sets = entries.map((entry) => entry.instances);
  const roots = treeOver(sets);
  /** Per mesh, per drawn position: the instance its buffers hold there (-1: unknown). */
  const shown = sets.map((set) => new Int32Array(set.count).fill(-1));
  const drawn = new Int32Array(entries.length);
  const firstChanged = new Float64Array(entries.length);
  /** Culled for the camera since the last `invalidate`. */
  const current = new Uint8Array(entries.length);
  /** Culled by the walk in progress. */
  const on = new Uint8Array(entries.length);
  const probe = new Sphere();
  let frustum: Frustum | null = null;

  /** Instances `start` to `end` of mesh `k` drawn next; one by one against the frustum when `test`. */
  const take = (k: number, start: number, end: number, test: boolean): void => {
    const { mesh } = entries[k]!;
    const set = sets[k]!, sp = set.spheres, at = shown[k]!, matrices = set.matrices;
    const colours = set.colours && mesh.instanceColor ? set.colours : null;
    const target = mesh.instanceMatrix.array as Float32Array;
    const tints = colours ? mesh.instanceColor!.array as Float32Array : null;
    let n = drawn[k]!;
    for (let i = start; i < end; i++) {
      if (test) {
        // A cell across the view's edge: its instances one by one, the same test as ever.
        probe.center.set(sp[i * 4]!, sp[i * 4 + 1]!, sp[i * 4 + 2]!);
        probe.radius = sp[i * 4 + 3]! + margin;
        if (!frustum!.intersectsSphere(probe)) continue;
      }
      // Written only when this position held another instance.
      if (at[n] !== i) {
        at[n] = i;
        if (n < firstChanged[k]!) firstChanged[k] = n;
        for (let j = 0; j < 16; j++) target[n * 16 + j] = matrices[i * 16 + j]!;
        if (colours && tints) {
          tints[n * 3] = colours[i * 3]!;
          tints[n * 3 + 1] = colours[i * 3 + 1]!;
          tints[n * 3 + 2] = colours[i * 3 + 2]!;
        }
      }
      n++;
    }
    drawn[k] = n;
  };
  /**
   * The node and what it holds against the planes of `mask` still unsettled
   * for it (0: wholly in view, nothing under it tested). A node's sphere
   * holds its instances' spheres, so a node out of view by the margin has
   * every instance out by it, and one in view by it has every instance in:
   * the instances kept are exactly those the per-instance test keeps.
   */
  const visit = (node: CullNode, mask: number): void => {
    let inner = mask;
    if (mask !== 0) {
      inner = planeMask(frustum!, node.x, node.y, node.z, node.r + PAD + margin, mask);
      if (inner < 0) return;
    }
    if (inner !== 0 && node.children) {
      for (const child of node.children) visit(child, inner);
      return;
    }
    // Wholly in view (each mesh's run taken whole), or a leaf across the edge.
    const spans = node.spans;
    for (let t = 0; t < spans.length; t += 3) {
      const k = spans[t]!;
      if (on[k]) take(k, spans[t + 1]!, spans[t + 2]!, inner !== 0);
    }
  };

  return {
    invalidate() { current.fill(0); },
    cull(view: Frustum, active) {
      let any = false;
      for (let k = 0; k < entries.length; k++) {
        on[k] = !current[k] && active(k) ? 1 : 0;
        if (on[k]) { any = true; drawn[k] = 0; firstChanged[k] = Infinity; }
      }
      if (!any) return;
      frustum = view;
      for (const root of roots) visit(root, ALL_PLANES);
      frustum = null;
      for (let k = 0; k < entries.length; k++) {
        if (!on[k]) continue;
        current[k] = 1;
        const { mesh } = entries[k]!;
        const n = drawn[k]!, first = firstChanged[k]!;
        // Only the positions whose instance changed go to the GPU; the same
        // instances in view (a small turn, a forced recull) upload nothing.
        if (first < n) {
          markRange(mesh.instanceMatrix, first * 16, (n - first) * 16);
          if (sets[k]!.colours && mesh.instanceColor) markRange(mesh.instanceColor, first * 3, (n - first) * 3);
        }
        mesh.count = n;
      }
    },
  };
}
