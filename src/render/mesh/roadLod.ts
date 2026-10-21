import { BufferAttribute, BufferGeometry, type Mesh } from 'three';
import type { BlockArrays } from './roadLodPure';
import type { GeometryArrays } from './gpuOnly';

export { blockBuffers, coarseArrays, type BlockArrays } from './roadLodPure';

/** DO NOT draw a far block at full detail: nothing there is resolved. */

/** A coarse block's geometry from its arrays. */
export function coarseGeometry(arrays: BlockArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  if (arrays.color) geometry.setAttribute('color', new BufferAttribute(arrays.color, 3));
  if (arrays.roadSection) geometry.setAttribute('roadSection', new BufferAttribute(arrays.roadSection, 3));
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
  /** A block of several surfaces drawn alike (`roadSurfaces.ts` drawGroups): each other surface's centre (x, z), as its own block had it.
   *  The block is near where any of them would be: none drawn coarser than it was as a block of its own. */
  readonly also?: readonly (readonly [number, number])[];
  /** Whether the full level is on the GPU (its arrays given back when it comes near: `bring`, else `refillArrays`). */
  full: boolean;
  /** The full level's arrays made off the page when the block comes near (the kept tiles read from the store, `roadSurfaces.ts`); null: not kept, cut again on the page. Unset: no such source (tests). */
  bring?: (() => Promise<GeometryArrays | null>) | null;
  /** Whether `bring` is under way: the block shows the full level when it lands. */
  bringing?: boolean;
  /** The last look it met the view at (`roadResidency.ts` updateRoadLevels): the least recently seen go first past the budget. */
  seenAt?: number;
  /** Its full level's bytes on the GPU as last measured: what bringing it near costs. */
  nearBytes?: number;
}

export const LOD_KEY = 'lod';

export const levelsOf = (mesh: Mesh): BlockLevels | undefined => mesh.userData[LOD_KEY] as BlockLevels | undefined;
