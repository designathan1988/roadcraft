import type { BufferAttribute, BufferGeometry, InterleavedBuffer, Object3D } from 'three';

/** DO NOT keep a mesh's arrays for a later rebuild: rebuild from the data it was made from. */

/** Each attribute's array by the attribute's name, and the index's under `index`. */
export type GeometryArrays = Readonly<Record<string, ArrayLike<number>>>;

/** What three uploads with an upload callback: an attribute or an interleaved buffer. */
type Uploaded = BufferAttribute | InterleavedBuffer;

const REFILL = 'refillArrays';

function letGo(this: Uploaded): void {
  const self = this as { array: (ArrayLike<number> & { byteLength?: number }) | null };
  // Its size remembered for the memory counters (`memoryCounters.ts`): a byte or a short a value, not always a float.
  if (self.array?.byteLength !== undefined) (this as unknown as { keptBytes?: number }).keptBytes = self.array.byteLength;
  self.array = null;
}

/** Lets the arrays of `own` (a mesh's own attributes by name) go once each is on the GPU */
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
