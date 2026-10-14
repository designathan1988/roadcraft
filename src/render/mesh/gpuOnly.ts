import type { BufferAttribute, BufferGeometry, Object3D } from 'three';

/**
 * GEOMETRY THAT LIVES ON THE GPU ONLY. A mesh put together from data the game
 * keeps anyway (the road tiles, the buildings' masses and chunks) is a copy:
 * once the renderer has its arrays on the GPU nothing reads them on the CPU
 * (its bounds are worked out before; nothing raycasts the town's meshes), so
 * each attribute lets its array go in its own upload callback (three's
 * `BufferAttribute.onUpload`: "clean-up operations after the upload when
 * attribute data are not needed anymore on the CPU side"). A mesh the camera
 * has not framed yet is not uploaded yet, and keeps its arrays until it is.
 *
 * Kept, these copies were the whole of the geometry on the CPU side - 2.6 GB
 * of the heap in a 2,560 m city (2026-10-14: asphalt, footway, kerb, verge,
 * kerb ramps, building masses), and most of the garbage collector's time.
 * DO NOT keep a mesh's arrays for a later rebuild: rebuild from the data it
 * was made from. A WebGL context lost and restored makes three upload every
 * buffer again from `attribute.array` (`WebGLAttributes.createBuffer`):
 * `refillArrays` puts each mesh's arrays back from its source first.
 */

/** Each attribute's array by the attribute's name, and the index's under `index`. */
export type GeometryArrays = Readonly<Record<string, ArrayLike<number>>>;

const REFILL = 'refillArrays';

function letGo(this: BufferAttribute): void {
  (this as { array: ArrayLike<number> | null }).array = null;
}

/**
 * Lets `mesh`'s arrays go once each is on the GPU; `arrays` makes them again
 * from what the mesh was made from (the same names as its attributes). Its
 * bounds must already be worked out (`computeBoundingSphere`/`Box`).
 */
export function gpuOnly(mesh: Object3D & { geometry: BufferGeometry }, arrays: () => GeometryArrays): void {
  const g = mesh.geometry;
  for (const attribute of Object.values(g.attributes)) (attribute as BufferAttribute).onUpload(letGo);
  g.index?.onUpload(letGo);
  mesh.userData[REFILL] = (): void => {
    const again = arrays();
    const set = (attribute: BufferAttribute, array: ArrayLike<number> | undefined): void => {
      if (!array) return;
      (attribute as { array: ArrayLike<number> }).array = array;
      attribute.needsUpdate = true;
    };
    for (const [name, attribute] of Object.entries(g.attributes)) set(attribute as BufferAttribute, again[name]);
    if (g.index) set(g.index, again.index);
  };
}

/** Every GPU-only mesh under `root` given its arrays again (a WebGL context restored). */
export function refillArrays(root: Object3D): void {
  root.traverse((o) => { (o.userData[REFILL] as (() => void) | undefined)?.(); });
}
