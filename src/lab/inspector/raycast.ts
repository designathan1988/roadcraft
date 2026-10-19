import { Box3, type BufferAttribute, type BufferGeometry, type InstancedMesh, type Intersection, Matrix4, type Object3D, Ray, Raycaster, Vector3 } from 'three';
import { m } from '@core/units';
import type { LabContext } from '../labTypes';
import type { Hit } from './state';

/** THE INSPECTOR'S RAY: the camera's line of sight through a pixel (`Viewport.rayAt`, the rig's own camera) and every 3D object it meets.
 *  three's `Raycaster.intersectObject` walks hidden objects too and throws on a mesh whose arrays were let go after their upload (`mesh/gpuOnly.ts`):
 *  so the scene is walked here, hidden branches skipped, and a mesh with no arrays on the CPU met by its bounds (`exact` false). */

/** Objects of the inspector's own (the highlight), never picked. */
export const INSPECTOR_OWN = 'labInspector';

/** The ray through a canvas pixel (CSS px from the canvas's corner), in three's world (x, height, -y); null where the view has no line of sight. */
export function rayAtPixel(ctx: LabContext, px: number, py: number): Ray | null {
  const rect = ctx.scene.gl.domElement.getBoundingClientRect();
  const sight = ctx.scene.viewport.rayAt?.(px, py, rect.width, rect.height);
  if (!sight) return null;
  return new Ray(new Vector3(sight.ox, sight.oz, -sight.oy), new Vector3(sight.dx, sight.dz, -sight.dy).normalize());
}

/** Whether an attribute still has its array on the CPU (`gpuOnly.ts` lets it go after the upload). */
const hasArray = (a: BufferAttribute | null | undefined): boolean => {
  if (!a) return false;
  const inter = a as unknown as { isInterleavedBufferAttribute?: boolean; data?: { array: ArrayLike<number> | null } };
  const array = inter.isInterleavedBufferAttribute ? inter.data?.array : (a.array as ArrayLike<number> | null);
  return !!array && array.length > 0;
};

/** Whether three can test the object's triangles: its positions, its index and (instanced) its matrices on the CPU. */
export function testable(object: Object3D): boolean {
  const geometry = (object as { geometry?: BufferGeometry }).geometry;
  if (!geometry) return false;
  if (!hasArray(geometry.getAttribute('position') as BufferAttribute)) return false;
  if (geometry.index && !hasArray(geometry.index)) return false;
  const inst = object as InstancedMesh;
  if (inst.isInstancedMesh && !hasArray(inst.instanceMatrix)) return false;
  return true;
}

/** Whether what is drawn is moved in the vertex shader (a crowd posed on the GPU, wind): the CPU's triangles may not be where it is drawn. */
export function shaderPosed(object: Object3D): boolean {
  const material = (object as { material?: unknown }).material;
  const list = Array.isArray(material) ? material : material ? [material] : [];
  return list.some((mat) => {
    const m2 = mat as { isShaderMaterial?: boolean; vertexShader?: string; onBeforeCompile?: unknown; constructor: { prototype: { onBeforeCompile?: unknown } } };
    const custom = typeof m2.onBeforeCompile === 'function' && m2.onBeforeCompile !== Object.getPrototypeOf(m2).onBeforeCompile;
    return custom || (m2.isShaderMaterial === true);
  }) || (object as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

const drawable = (o: Object3D): boolean => {
  const k = o as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return !!(k.isMesh || k.isPoints || k.isLine || k.isSprite);
};

const boxHit = new Vector3();
const box = new Box3();
const local = new Matrix4();
const world = new Matrix4();

/** The ray against an object's bounds: each instance's box for an instanced mesh, else the whole object's. */
function boundsHits(object: Object3D, ray: Ray, out: Hit[]): void {
  const inst = object as InstancedMesh;
  const geometry = (object as { geometry?: BufferGeometry }).geometry;
  if (inst.isInstancedMesh && geometry?.boundingBox && hasArray(inst.instanceMatrix)) {
    let best: Hit | null = null;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, local);
      world.multiplyMatrices(inst.matrixWorld, local);
      box.copy(geometry.boundingBox).applyMatrix4(world);
      if (!ray.intersectBox(box, boxHit)) continue;
      const d = ray.origin.distanceTo(boxHit);
      if (!Number.isFinite(d)) continue;
      if (!best || d < best.distance) best = { object, distance: d, point: boxHit.clone(), instanceId: i, batchId: null, exact: false };
    }
    if (best) out.push(best);
    return;
  }
  try {
    box.setFromObject(object, false);
  } catch (error) {
    console.warn('lab inspector: no bounds for', object.name, error);
    return;
  }
  if (box.isEmpty() || !ray.intersectBox(box, boxHit) || !Number.isFinite(boxHit.x + boxHit.y + boxHit.z)) return;
  out.push({ object, distance: ray.origin.distanceTo(boxHit), point: boxHit.clone(), instanceId: null, batchId: null, exact: false });
}

/** Every visible object the ray meets, nearest first: by its triangles where three can test them, by its bounds otherwise (and for the ones posed in their shader, both). */
export function hitsAlong(root: Object3D, ray: Ray): Hit[] {
  const raycaster = new Raycaster();
  raycaster.ray.copy(ray);
  raycaster.params.Points.threshold = m(0.4);
  raycaster.params.Line.threshold = m(0.2);
  const out: Hit[] = [];
  const found: Intersection[] = [];
  const stack: Object3D[] = [root];
  while (stack.length) {
    const o = stack.pop()!;
    if (!o.visible || o.userData[INSPECTOR_OWN]) continue;
    for (const child of o.children) stack.push(child);
    if (!drawable(o) || (o as { isSprite?: boolean }).isSprite) continue;
    // A mesh instanced zero times draws nothing.
    if ((o as InstancedMesh).isInstancedMesh && (o as InstancedMesh).count === 0) continue;
    const exactBefore = out.length;
    if (testable(o)) {
      found.length = 0;
      try {
        o.raycast(raycaster, found);
      } catch (error) {
        console.warn('lab inspector: raycast failed on', o.name, error);
      }
      // The nearest of each object (an instanced mesh: of each instance).
      const nearest = new Map<number, Intersection>();
      for (const f of found) {
        // An instance whose matrix is not set (NaN) meets every ray: three's test passes on NaN.
        if (!Number.isFinite(f.distance) || !Number.isFinite(f.point.x + f.point.y + f.point.z)) continue;
        const key = f.instanceId ?? f.batchId ?? -1;
        const had = nearest.get(key);
        if (!had || f.distance < had.distance) nearest.set(key, f);
      }
      for (const f of nearest.values()) {
        out.push({ object: o, distance: f.distance, point: f.point.clone(), instanceId: f.instanceId ?? null, batchId: f.batchId ?? null, exact: true });
      }
    }
    if (out.length === exactBefore && (!testable(o) || shaderPosed(o))) boundsHits(o, ray, out);
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/** The hit the selection takes: the nearest solid met by its triangles; else the smallest solid met by its bounds (the roads and buildings let their arrays go);
 *  else what is seen through. */
export function primaryHit(hits: readonly Hit[]): Hit | null {
  const exact = solidExact(hits);
  if (exact) return exact;
  return smallest(hits.filter((h) => !h.exact && !seeThrough(h))) ?? hits.find((h) => h.exact) ?? smallest(hits);
}

/** The nearest solid hit met by its triangles; null when only bounds (or see-through things) were met. */
export function solidExact(hits: readonly Hit[]): Hit | null {
  return hits.find((h) => h.exact && seeThrough(h) === false) ?? null;
}

/** A glow, a light's cone or a pool of light (transparent, writing no depth): seen through, the solid behind it is what was pointed at (it stays in "Sob o cursor"). */
function seeThrough(h: Hit): boolean {
  const material = (h.object as { material?: { transparent?: boolean; depthWrite?: boolean } | { transparent?: boolean; depthWrite?: boolean }[] }).material;
  const first = Array.isArray(material) ? material[0] : material;
  return !!(first?.transparent && first.depthWrite === false);
}

/** The hit with the smallest bounds among the nearest few. */
function smallest(list: readonly Hit[]): Hit | null {
  let best: Hit | null = null;
  let bestRadius = Infinity;
  for (const h of list.slice(0, 16)) {
    const radius = boundsRadius(h.object);
    if (radius < bestRadius) { best = h; bestRadius = radius; }
  }
  return best;
}

/** The groups each kind of the game's entities is drawn in (the scene as `renderer.ts` builds it). */
const ENTITY_LAYERS: Readonly<Record<string, RegExp>> = {
  building: /^buildings-layer$/,
  segment: /^road-network$|^roads-far|^road-structure-details$|^road-stand-ins$/,
  node: /^road-network$|^roads-far|^road-structure-details$|^road-stand-ins$|^traffic-signals$/,
  vehicle: /^agent-parts$|^densityCars$/,
  person: /^agent-parts$/,
  terrain: /^flat-world-ground$|^terrain-/,
};

/** Among the hits, the one drawing the game's entity (found by the game's own pick) where no solid was met by its triangles:
 *  a road's or a building's meshes let their arrays go, and their bounds are whole blocks; their layer says which is the entity's. */
export function hitForEntity(hits: readonly Hit[], kind: string): Hit | null {
  const layer = ENTITY_LAYERS[kind];
  if (!layer) return null;
  const mine = hits.filter((h) => {
    for (let o: Object3D | null = h.object; o && o.parent; o = o.parent) if (layer.test(o.name)) return true;
    return false;
  });
  return mine.find((h) => h.exact) ?? smallest(mine);
}

function boundsRadius(o: Object3D): number {
  const g = (o as { geometry?: BufferGeometry }).geometry;
  const sphere = (o as { boundingSphere?: { radius: number } | null }).boundingSphere ?? g?.boundingSphere;
  return sphere ? sphere.radius * o.matrixWorld.getMaxScaleOnAxis() : Infinity;
}

/** The world box of what is selected: one instance's, a batch's, or the whole object's; null when it has none. */
export function selectionBox(object: Object3D, instanceId: number | null, batchId: number | null): Box3 | null {
  const out = new Box3();
  const geometry = (object as { geometry?: BufferGeometry }).geometry;
  const inst = object as InstancedMesh;
  try {
    if (instanceId !== null && inst.isInstancedMesh && geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox || !hasArray(inst.instanceMatrix)) return null;
      inst.getMatrixAt(instanceId, local);
      out.copy(geometry.boundingBox).applyMatrix4(world.multiplyMatrices(inst.matrixWorld, local));
      return Number.isFinite(out.min.x + out.max.x) ? out : null;
    }
    const batched = object as unknown as { isBatchedMesh?: boolean; getMatrixAt(i: number, m4: Matrix4): Matrix4; getGeometryIdAt(i: number): number; getBoundingBoxAt(g: number, b: Box3): Box3 | null };
    if (batchId !== null && batched.isBatchedMesh) {
      const g = batched.getGeometryIdAt(batchId);
      if (!batched.getBoundingBoxAt(g, out)) return null;
      batched.getMatrixAt(batchId, local);
      return out.applyMatrix4(world.multiplyMatrices(object.matrixWorld, local));
    }
    out.setFromObject(object, false);
    return out.isEmpty() || !Number.isFinite(out.min.x + out.max.x) ? null : out;
  } catch (error) {
    console.warn('lab inspector: no box for', object.name, error);
    return null;
  }
}
