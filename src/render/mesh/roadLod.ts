import { BufferAttribute, BufferGeometry, type Mesh } from 'three';
import type { BlockArrays } from './roadLodPure';

export { COARSE_ERROR,   coarseArrays, type BlockArrays } from './roadLodPure';

/**
 * THE FAR LEVEL OF A BLOCK OF ROAD SURFACE, as meshes (`roadLodPure.ts` makes the arrays, in a worker): the
 * block's own mesh simplified, one of the two on the GPU (`roadResidency.ts`). The road surfaces were 1.04 GB
 * of a 2,560 m city's 1.56 GB of geometry, every block at full detail wherever the camera was (2026-10-15).
 * DO NOT draw a far block at full detail: nothing there is resolved.
 */

/** A coarse block's geometry from its arrays. */
export function coarseGeometry(arrays: BlockArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  geometry.setAttribute('color', new BufferAttribute(arrays.color, 3));
  geometry.setAttribute('roadSection', new BufferAttribute(arrays.roadSection, 3));
  geometry.setIndex(new BufferAttribute(arrays.index, 1));
  return geometry;
}

/** What a block keeps of its two levels (`mesh.userData.lod`). */
export interface BlockLevels {
  /** The far level, null where the block is too small to have one. */
  readonly coarse: Mesh | null;
  /** The block's centre in the scene (x, z), for the distance to the camera. */
  readonly x: number;
  readonly z: number;
  /** Whether the full level is on the GPU (its arrays given back by `refillArrays` when it comes). */
  full: boolean;
}

export const LOD_KEY = 'lod';

export const levelsOf = (mesh: Mesh): BlockLevels | undefined => mesh.userData[LOD_KEY] as BlockLevels | undefined;
