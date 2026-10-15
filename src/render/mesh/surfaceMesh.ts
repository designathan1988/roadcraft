import {
  BufferGeometry,
  Mesh,
  type Material,
} from 'three';

import type { MultiPoly } from '@core/clipper';
import type { TileMeshOptions } from './tileMesh';

export {  type TileRect } from './tileShape';
export { meshTileShape,  type Tile,     } from './tileMesh';

/**
 * Turns a clipped surface band into a solid, watertight mesh.
 *
 * ## The two failures this module exists to prevent
 *
 * **Chords under the ground.** A deck vertex reads the height field only AT
 * ITSELF, and the triangle between two vertices is a straight chord. If that
 * chord is long and the surface it follows is curved, the chord dives beneath
 * the surface: the terrain cuts the road into plates. Densifying only the
 * polygon OUTLINE does not fix it, because ear clipping happily draws a single
 * triangle straight across a 60-unit boulevard. The fix is to refine the
 * TRIANGULATION until no edge is longer than `maxEdge`.
 *
 * **Cracks from a T-junction.** Refining each triangle on its own splits an
 * edge that its neighbour leaves whole, and the two no longer meet: a hairline
 * of background shows through. The refinement below is therefore done with
 * shared, cached edge midpoints and the standard red/green rule — a triangle
 * with one, two or three marked edges is split into two, three or four — so
 * every shared edge is split identically from both sides and no T-junction can
 * ever appear.
 */

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
