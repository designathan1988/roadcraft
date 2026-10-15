import { BufferAttribute, BufferGeometry, type Mesh } from 'three';
import { gpuOnly } from './gpuOnly';
import { finish, type SurfaceMeshOptions, type Tile } from './surfaceMesh';

/** A surface's tiles, in order, as one mesh's arrays (the indices shifted); null for none. */
function tileArrays(parts: readonly Tile[]): {
  position: Float32Array; normal: Float32Array; uv: Float32Array; color: Float32Array; roadSection: Float32Array; index: Uint16Array | Uint32Array;
} | null {
  let vertices = 0;
  let count = 0;
  for (const tile of parts) {
    vertices += tile.positions.length / 3;
    count += tile.indices.length;
  }
  if (count === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const color = new Float32Array(vertices * 3);
  const roadSection = new Float32Array(vertices * 3);
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    position.set(tile.positions, v * 3);
    normal.set(tile.normals, v * 3);
    uv.set(tile.uvs, v * 2);
    color.set(tile.colors, v * 3);
    roadSection.set(tile.sections, v * 3);
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) index[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  return { position, normal, uv, color, roadSection, index };
}

/**
 * One mesh of a surface from its tiles, in order. The mesh is the only copy
 * the network keeps, on the GPU (`gpuOnly`): `source` makes its tiles again
 * from what they were made from (`roadSurfaces.ts`), for a lost WebGL context.
 * DO NOT pass a source that returns `parts`: the closure would hold every
 * tile's arrays for as long as the mesh lives.
 */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, source: () => readonly Tile[]): Mesh | null {
  const arrays = tileArrays(parts);
  if (!arrays) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  geometry.setAttribute('color', new BufferAttribute(arrays.color, 3));
  geometry.setAttribute('roadSection', new BufferAttribute(arrays.roadSection, 3));
  geometry.setIndex(new BufferAttribute(arrays.index, 1));
  const mesh = finish(geometry, options);
  tilesOnGpu(mesh, source);
  return mesh;
}

/** A merged mesh's arrays let go once on the GPU, and made again from `source`'s tiles when asked (`gpuOnly`). */
export function tilesOnGpu(mesh: Mesh, source: () => readonly Tile[]): void {
  gpuOnly(mesh as Mesh & { geometry: BufferGeometry }, () => tileArrays(source())!);
}
