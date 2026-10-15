import { BufferGeometry, Float32BufferAttribute, type Mesh } from 'three';

import { surfaceShape } from '@render/mesh/tileShape';
import { type Context, meshPiece, meshSkirts, smoothTopNormals, streams } from '@render/mesh/tileMesh';
import { finish, type SurfaceMeshOptions } from '@render/mesh/surfaceMesh';

/**
 * A whole clipped surface band meshed in one piece, uncut by tiles: the game's
 * own shape and mesh steps (`surfaceShape`, `meshPiece`, `meshSkirts`,
 * `smoothTopNormals`) put together, so the specs check their contract on a
 * plain polygon.
 */
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
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('roadSection', new Float32BufferAttribute(sections, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
}
