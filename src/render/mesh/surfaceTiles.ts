import { Box3, BufferGeometry, Sphere, type Material, type Mesh } from 'three';
import { type GeometryArrays, gpuOnly } from './gpuOnly';
import { type BlockArrays, type BlockLevels, LOD_KEY, coarseArrays, coarseGeometry } from './roadLod';
import { readsRoadSection } from './roadEdges';
import { makeFar } from './roadResidency';
import { finish, type SurfaceMeshOptions, type Tile, type TileRect } from './surfaceMesh';

/** The attributes a surface's material reads besides position, normal and uv: no other is sent to the GPU. */
interface SurfaceReads {
  readonly color: boolean;
  readonly section: boolean;
}

/** What `material` reads: the vertex colour only with `vertexColors` (three defines USE_COLOR from it), the section only with the road edges. */
function readsOf(material: Material | Material[]): SurfaceReads {
  const one = Array.isArray(material) ? material : [material];
  return { color: one.some((m) => m.vertexColors), section: one.some(readsRoadSection) };
}

/** A surface's tiles, in order, as one mesh's arrays (the indices shifted), with only what its material reads; null for none. */
function tileArrays(parts: readonly Tile[], reads: SurfaceReads): BlockArrays | null {
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
  const color = reads.color ? new Float32Array(vertices * 3) : undefined;
  const roadSection = reads.section ? new Float32Array(vertices * 3) : undefined;
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    position.set(tile.positions, v * 3);
    normal.set(tile.normals, v * 3);
    uv.set(tile.uvs, v * 2);
    const n = tile.positions.length / 3;
    // A tile with no tint is white, one with no section has none (`tileMesh.ts` meshPiece): what it would have carried.
    if (color) { if (tile.colors.length) color.set(tile.colors, v * 3); else color.fill(1, v * 3, (v + n) * 3); }
    if (roadSection) {
      if (tile.sections.length) roadSection.set(tile.sections, v * 3);
      else for (let i = v; i < v + n; i++) { roadSection[i * 3] = 0; roadSection[i * 3 + 1] = -1; roadSection[i * 3 + 2] = 0; }
    }
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) index[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  return { position, normal, uv, ...(color ? { color } : {}), ...(roadSection ? { roadSection } : {}), index };
}

/** DO NOT pass a source that returns `parts`: the closure would hold every tile's arrays for as long as the mesh lives. */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, source: () => readonly Tile[],
  far?: { readonly lock: readonly [number, number, number, number]; readonly near: boolean; readonly start?: (mesh: Mesh, arrays: BlockArrays) => void;
    /** The other surfaces' blocks' boxes, for a block of several (`BlockLevels.also`). */
    readonly also?: readonly (readonly [number, number, number, number])[];
    /** The road block's cell (`BlockLevels.cell`). */
    readonly cell?: string }): Mesh | null {
  const arrays = tileArrays(parts, readsOf(options.material));
  if (!arrays) return null;
  const geometry = coarseGeometry(arrays);
  // Bounded by its tiles' boxes, made with them in the worker (`tileMesh.ts`)
  if (parts.every((tile) => tile.box)) {
    const box = new Box3();
    for (const tile of parts) {
      const b = tile.box!;
      if (b[0]! > b[3]!) continue;
      box.min.set(Math.min(box.min.x, b[0]!), Math.min(box.min.y, b[1]!), Math.min(box.min.z, b[2]!));
      box.max.set(Math.max(box.max.x, b[3]!), Math.max(box.max.y, b[4]!), Math.max(box.max.z, b[5]!));
    }
    geometry.boundingBox = box;
    geometry.boundingSphere = box.getBoundingSphere(new Sphere());
  }
  const mesh = finish(geometry, options);
  tilesOnGpu(mesh, source);
  if (far) {
    // DO NOT simplify it here, a block after the other on the page.
    mesh.userData[LOD_KEY] = {
      coarse: null, x: (far.lock[0] + far.lock[2]) / 2, z: -(far.lock[1] + far.lock[3]) / 2, full: true,
      ...(far.also?.length ? { also: far.also.map((b): [number, number] => [(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2]) } : {}),
      ...(far.cell !== undefined ? { cell: far.cell } : {}),
    } satisfies BlockLevels;
    far.start?.(mesh, arrays);
  }
  return mesh;
}

/** A block's arrays copied: what a worker is handed to simplify while the block keeps its own. */
export function cloneBlock(arrays: BlockArrays): BlockArrays {
  return {
    position: arrays.position.slice(), normal: arrays.normal.slice(), uv: arrays.uv.slice(),
    ...(arrays.color ? { color: arrays.color.slice() } : {}), ...(arrays.roadSection ? { roadSection: arrays.roadSection.slice() } : {}),
    index: arrays.index.slice(),
  };
}

/** A surface's share of a block: its tiles' vertices and indices (`memberSizes`). */
export interface MemberSize { readonly vertices: number; readonly count: number }

/** Each surface's share of a block, from its tiles (in the order they were merged): what `splitBlock` cuts by, without the tiles. */
export function memberSizes(members: readonly (readonly Tile[])[]): MemberSize[] {
  return members.map((tiles) => {
    let vertices = 0, count = 0;
    for (const tile of tiles) { vertices += tile.positions.length / 3; count += tile.indices.length; }
    return { vertices, count };
  });
}

/** A block's arrays cut back into its surfaces' (`members`: each surface's share, in the order they were merged), each a copy: what a block
 *  of several surfaces drawn alike hands its workers to simplify, a surface at a time, as each was simplified when it was a block of its own. */
export function splitBlock(arrays: BlockArrays, members: readonly MemberSize[]): BlockArrays[] {
  const out: BlockArrays[] = [];
  let v = 0, k = 0;
  for (const { vertices, count } of members) {
    const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) index[i] = arrays.index[k + i]! - v;
    const cut = (a: Float32Array, size: number): Float32Array => a.slice(v * size, (v + vertices) * size);
    out.push({
      position: cut(arrays.position, 3), normal: cut(arrays.normal, 3), uv: cut(arrays.uv, 2),
      ...(arrays.color ? { color: cut(arrays.color, 3) } : {}), ...(arrays.roadSection ? { roadSection: cut(arrays.roadSection, 3) } : {}), index,
    });
    v += vertices;
    k += count;
  }
  return out;
}

/** Blocks' arrays end to end, as one mesh's (the indices shifted). */
export function joinBlocks(parts: readonly BlockArrays[]): BlockArrays {
  if (parts.length === 1) return parts[0]!;
  let vertices = 0, count = 0;
  for (const part of parts) { vertices += part.position.length / 3; count += part.index.length; }
  const join = (pick: (part: BlockArrays) => Float32Array | undefined, size: number): Float32Array | undefined => {
    if (!pick(parts[0]!)) return undefined;
    const out = new Float32Array(vertices * size);
    let at = 0;
    for (const part of parts) { out.set(pick(part)!, at); at += (part.position.length / 3) * size; }
    return out;
  };
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0, k = 0;
  for (const part of parts) {
    for (let i = 0; i < part.index.length; i++) index[k++] = part.index[i]! + v;
    v += part.position.length / 3;
  }
  const color = join((p) => p.color, 3), roadSection = join((p) => p.roadSection, 3);
  return {
    position: join((p) => p.position, 3)!, normal: join((p) => p.normal, 3)!, uv: join((p) => p.uv, 2)!,
    ...(color ? { color } : {}), ...(roadSection ? { roadSection } : {}), index,
  };
}

/** One surface of a block: its tiles, and its own block's edge, locked when it is simplified (`coarseArrays`). */
export interface BlockMember {
  readonly source: () => readonly Tile[];
  readonly lock: readonly [number, number, number, number];
}

/** The block's far level (`roadLod.ts`) as it arrives from its worker; `members`, each surface it draws (one, or several drawn alike), each simplified on its own. */
export function attachFarLevel(mesh: Mesh, coarse: BlockArrays, options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, members: readonly BlockMember[], near: boolean): Mesh {
  const level = finish(coarseGeometry(coarse), { ...options, name: `${options.name}-far` });
  // Made again from the block's tiles when a lost context asks, like the block's own. DO NOT fall back on `coarse`: the closure held the worker's arrays on the page for the block's life, after they were on the GPU.
  const reads = readsOf(options.material);
  const again: () => GeometryArrays = members.length === 1
    ? () => coarseArrays(tileArrays(members[0]!.source(), reads)!, members[0]!.lock) ?? emptyLike(level)
    // A surface too small to simplify is drawn whole in the far level, as its own block was.
    : () => joinBlocks(members.flatMap(({ source, lock }) => { const full = tileArrays(source(), reads); return full ? [coarseArrays(full, lock) ?? full] : []; }));
  level.userData[FAR_AGAIN] = again;
  gpuOnly(level, again);
  const levels = mesh.userData[LOD_KEY] as BlockLevels;
  (levels as { coarse: Mesh | null }).coarse = level;
  level.renderOrder = mesh.renderOrder;
  level.visible = !near;
  mesh.parent?.add(level);
  if (!near) makeFar(mesh);
  return level;
}

/** Where a far level keeps how its arrays are made again from its tiles on the page (`attachFarLevel`, `restoreFarLevel`). */
const FAR_AGAIN = 'farAgain';

/**
 * A far level let go (`roadResidency.ts` dropCell) made again: its geometry replaced by one of `arrays` (made off the page, `BlockLevels.remake`),
 * or, none given, of its tiles cut again here. A new geometry, not the old one refilled: the arrays made again need not be as many as the
 * first (another simplification's count), and three draws an attribute by the count it was made with (`BufferAttribute.count`).
 */
export function restoreFarLevel(level: Mesh, arrays: BlockArrays | null): void {
  const again = level.userData[FAR_AGAIN] as (() => GeometryArrays) | undefined;
  const made = arrays ?? (again?.() as BlockArrays | undefined);
  if (!made) return;
  const old = level.geometry;
  const geometry = coarseGeometry(made);
  if (old.boundingBox) geometry.boundingBox = old.boundingBox.clone();
  if (old.boundingSphere) geometry.boundingSphere = old.boundingSphere.clone();
  old.dispose();
  level.geometry = geometry;
  if (again) gpuOnly(level, again);
}

/** A mesh's arrays at their sizes, all zero (every triangle of no area): what a far level the tiles no longer simplify to is given back, never the arrays it was made with. */
function emptyLike(mesh: Mesh): Record<string, ArrayLike<number>> {
  const g = mesh.geometry;
  const out: Record<string, ArrayLike<number>> = {};
  for (const [name, attribute] of Object.entries(g.attributes)) out[name] = new Float32Array(attribute.count * attribute.itemSize);
  // Of the type it was made with: by its vertices (`roadLodPure.ts` coarse index).
  if (g.index) out.index = (g.getAttribute('position')?.count ?? 0) > 0xffff ? new Uint32Array(g.index.count) : new Uint16Array(g.index.count);
  return out;
}

/** A block's arrays from its tiles as kept (the store's), for the attributes its material reads: a copy end to end, nothing cut (`roadResidency.ts` makeNear). */
export function blockArraysOf(tiles: readonly Tile[], material: Material): BlockArrays | null {
  return tileArrays(tiles, readsOf(material));
}

/** A merged mesh's arrays let go once on the GPU, and made again from `source`'s tiles when asked (`gpuOnly`). */
export function tilesOnGpu(mesh: Mesh, source: () => readonly Tile[]): void {
  const reads = readsOf(mesh.material);
  gpuOnly(mesh as Mesh & { geometry: BufferGeometry }, () => tileArrays(source(), reads)!);
}

/** The box round a block's tiles' rectangles, [minX, minY, maxX, maxY]. */
export function blockBox(rects: readonly TileRect[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) { minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]); maxX = Math.max(maxX, r[2]); maxY = Math.max(maxY, r[3]); }
  return [minX, minY, maxX, maxY];
}

/** Arrays end to end, with where each ends: one buffer to hand over instead of one an array. */
export function concat(parts: readonly ArrayLike<number>[]): { lineEnds: Uint32Array; lines: Float64Array } {
  let length = 0;
  for (const part of parts) length += part.length;
  const lines = new Float64Array(length);
  const lineEnds = new Uint32Array(parts.length);
  let at = 0;
  parts.forEach((part, i) => { lines.set(part, at); at += part.length; lineEnds[i] = at; });
  return { lineEnds, lines };
}
