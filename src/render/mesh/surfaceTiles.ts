import { BufferAttribute, BufferGeometry, type Mesh } from 'three';
import { finish, type SurfaceMeshOptions, type Tile } from './surfaceMesh';

/** One mesh of a surface from its tiles, in order. */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>): Mesh | null {
  let vertices = 0;
  let count = 0;
  for (const tile of parts) {
    vertices += tile.positions.length / 3;
    count += tile.indices.length;
  }
  if (count === 0) return null;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const colors = new Float32Array(vertices * 3);
  const sections = new Float32Array(vertices * 3);
  const indices = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    positions.set(tile.positions, v * 3);
    normals.set(tile.normals, v * 3);
    uvs.set(tile.uvs, v * 2);
    colors.set(tile.colors, v * 3);
    sections.set(tile.sections, v * 3);
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) indices[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('roadSection', new BufferAttribute(sections, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return finish(geometry, options);
}

