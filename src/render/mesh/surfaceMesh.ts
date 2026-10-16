import {
  BufferGeometry,
  Mesh,
  type Material,
} from 'three';

import type { MultiPoly } from '@core/clipper';
import type { TileMeshOptions } from './tileMesh';

export {  type TileRect } from './tileShape';
export { meshTileShape,  type Tile,     } from './tileMesh';

/** Turns a clipped surface band into a solid */

export interface SurfaceMeshOptions extends TileMeshOptions {
  readonly name: string;
  readonly polygons: MultiPoly;
  readonly material: Material;
  /** Longest triangle edge, in world units, before it is refined. */
  readonly maxEdge: number;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

export function finish(geometry: BufferGeometry,
  options: Pick<SurfaceMeshOptions, 'name' | 'material' | 'castShadow' | 'receiveShadow'>): Mesh {
  // Bounds given (a block of tiles: its tiles' boxes, `surfaceTiles.ts`) stand; else measured.
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const mesh = new Mesh(geometry, options.material);
  mesh.name = options.name;
  // Still where it was made (the world's origin): DO NOT compose and multiply its matrix every frame in every pass, as three does by default for each of thousands of blocks.
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

export function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  // The far level of a block of road (`roadLod.ts`) goes with it.
  const coarse = (mesh.userData.lod as { coarse: Mesh | null } | undefined)?.coarse;
  if (coarse) { coarse.geometry.dispose(); coarse.removeFromParent(); }
}
