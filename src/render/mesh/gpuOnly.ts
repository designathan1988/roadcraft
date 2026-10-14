import type { BufferAttribute, BufferGeometry, InterleavedBuffer, Object3D } from 'three';

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
 * was made from. DO NOT let go of what the mesh shares (a kit's geometry
 * drawn by every batch): only its own attributes. A WebGL context lost and
 * restored makes three upload every buffer again from its `array`
 * (`WebGLAttributes.createBuffer`): `refillArrays` puts each mesh's arrays
 * back from its source first.
 */

/** Each attribute's array by the attribute's name, and the index's under `index`. */
export type GeometryArrays = Readonly<Record<string, ArrayLike<number>>>;

/** What three uploads with an upload callback: an attribute or an interleaved buffer. */
type Uploaded = BufferAttribute | InterleavedBuffer;

const REFILL = 'refillArrays';

function letGo(this: Uploaded): void {
  (this as { array: ArrayLike<number> | null }).array = null;
}

/**
 * Lets the arrays of `own` (a mesh's own attributes by name) go once each is
 * on the GPU; `arrays` makes them again, by the same names, from what they
 * were made from. Bounds must already be worked out.
 */
export function gpuOnlyAttributes(holder: Object3D, own: Readonly<Record<string, Uploaded>>, arrays: () => GeometryArrays): void {
  for (const uploaded of Object.values(own)) uploaded.onUpload(letGo);
  holder.userData[REFILL] = (): void => {
    const again = arrays();
    for (const [name, uploaded] of Object.entries(own)) {
      const array = again[name];
      if (!array) continue;
      (uploaded as { array: ArrayLike<number> }).array = array;
      uploaded.needsUpdate = true;
    }
  };
}

/** `gpuOnlyAttributes` for every attribute and the index of a geometry the mesh owns. */
export function gpuOnly(mesh: Object3D & { geometry: BufferGeometry }, arrays: () => GeometryArrays): void {
  const g = mesh.geometry;
  const own: Record<string, Uploaded> = {};
  for (const [name, attribute] of Object.entries(g.attributes)) own[name] = attribute as BufferAttribute;
  if (g.index) own.index = g.index;
  gpuOnlyAttributes(mesh, own, arrays);
}

/** Every GPU-only mesh under `root` given its arrays again (a WebGL context restored). */
export function refillArrays(root: Object3D): void {
  root.traverse((o) => { (o.userData[REFILL] as (() => void) | undefined)?.(); });
}
