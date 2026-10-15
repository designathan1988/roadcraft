import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  type Material,
} from 'three';

import type { MultiPoly } from '@core/clipper';
import { surfaceShape, type TileRect } from './tileShape';
import { type Context, type TileMeshOptions, meshPiece, meshSkirts, meshTileShape, smoothTopNormals, streams, type Tile } from './tileMesh';

export { clipToRect, type TileRect } from './tileShape';
export { meshTileShape, type HeightFn, type Tile, type TileMeshOptions, type TintFn, type UvFn, type UvFrameFn } from './tileMesh';

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

export function buildSurfaceMesh(options: SurfaceMeshOptions): Mesh | null {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], cut: [0, -1, 0] };

  // Compact pieces first (`tileShape.ts` `splitToSpan`), then ear clipping inside each.
  const out = streams();
  const shape = surfaceShape(options.polygons, options.maxEdge, options.bottom !== undefined);
  for (const piece of shape.pieces) meshPiece(piece, context, out);
  if (shape.skirts) meshSkirts(shape.skirts, context, out);

  const { positions, normals, uvs, colors, sections, indices } = out;
  if (indices.length === 0) return null;
  // Only the top face was given a placeholder normal; recomputing just those
  // vertices keeps the skirt's hard edges while the surface itself is smooth.
  smoothTopNormals(positions, normals, indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // Always present, white when no tint was asked for: a material that declares
  // `vertexColors` requires the attribute, and it is cheaper to write three
  // ones than to keep two variants of every road material.
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('roadSection', new Float32BufferAttribute(sections, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
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

/**
 * Builds one tile of a surface: the top faces of `options.polygons` (already
 * cut to `rect`), and the skirts along every edge of their outline except the
 * edges the cut itself made, which are interior to the whole surface.
 */
export function meshTile(options: SurfaceMeshOptions, rect: TileRect): Tile {
  return meshTileShape(surfaceShape(options.polygons, options.maxEdge, options.bottom !== undefined, rect), options);
}

export function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
}
