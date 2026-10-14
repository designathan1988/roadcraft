import { FINISHES, type Finish } from '@world/buildings/materials';
import { FURNITURE_KINDS, type FurnitureKind } from '@world/buildings/interior';
import type { BuildingChunk, PartBatch } from './chunk';
import { FACADE_PROP_KINDS } from './facadeProps';
import type { PartKind } from './kit';
import { ROOM_FLOATS } from './roomBehind';

/**
 * A BATCH OF BUILDINGS AS ARRAYS: what `buildingMesh.ts` `meshesOf` wraps in
 * meshes, worked out from the buildings' chunks with no three.js, so it runs
 * where the chunks are - in the emit workers (`cellWork.ts`), as Cesium's
 * `combineGeometry` worker combines a primitive's geometries and hands back
 * the packed arrays - or on the page (the preview, the tests). Each array is
 * new and handed over as it is: the shells of every chunk concatenated (the
 * indices shifted), each part kind's instances in chunk order, and each
 * mesh's bounds as three works them out, so the page never walks a vertex.
 */

/** Parts drawn with a colour per instance: awnings, and the window frames and balcony railings in their building's trim (the materials are white). */
export const COLOURED_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['awning', 'frame', 'railing', 'fin', 'louvre', 'brise', ...FACADE_PROP_KINDS]));

/** What a batch takes: the part kinds, whether the shells and the furniture; the preview's look (`ghost`) or the faded one (`dim`). */
export interface CellSelection {
  readonly parts: readonly PartKind[];
  readonly shells: boolean;
  readonly furniture: boolean;
  readonly ghost: boolean;
  readonly dim: boolean;
}

/** A box and a sphere: minX, minY, minZ, maxX, maxY, maxZ, then centre x, y, z and radius (three's `Box3` and `Sphere`). */
export type Bounds = Float64Array;

export interface ShellArrays {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  readonly uv: Float32Array;
  readonly decay: Float32Array;
  readonly index: Uint32Array;
  readonly bounds: Bounds;
}

export interface InstanceArrays {
  readonly count: number;
  readonly instanceMatrix: Float32Array;
  readonly instanceColor?: Float32Array;
  /** Window panes: each one's light slot (-1: none) and the room behind it. */
  readonly litSlot?: Float32Array;
  readonly rooms?: Float32Array;
  readonly bounds: Bounds;
}

export interface CellArrays {
  readonly shells: Readonly<Partial<Record<Finish, ShellArrays>>>;
  readonly parts: Readonly<Partial<Record<PartKind, InstanceArrays>>>;
  readonly furniture: Readonly<Partial<Record<FurnitureKind, InstanceArrays>>>;
}

/** Each part's and each piece of furniture's geometry box (minX, minY, minZ, maxX, maxY, maxZ), as the kit draws them. */
export interface KitBoxes {
  readonly parts: Readonly<Record<PartKind, readonly number[]>>;
  readonly furniture: Readonly<Partial<Record<FurnitureKind, readonly number[]>>>;
}

/** The batch of `chunks` that `selection` takes, as arrays. */
export function cellArrays(chunks: readonly BuildingChunk[], selection: CellSelection, boxes: KitBoxes): CellArrays {
  const { ghost, dim } = selection;
  const shells: Partial<Record<Finish, ShellArrays>> = {};
  if (selection.shells) for (const finish of FINISHES) {
    const shell = shellArrays(chunks, finish);
    if (shell) shells[finish] = { ...shell, bounds: shellBounds(shell.position) };
  }
  const parts: Partial<Record<PartKind, InstanceArrays>> = {};
  for (const kind of selection.parts) {
    // A lantern's light on the wall is light, not a part: no ghost or faded copy of it.
    if (kind === 'wash' && (ghost || dim)) continue;
    let count = 0;
    for (const chunk of chunks) count += chunk.parts[kind].count;
    if (count === 0) continue;
    const glassy = !ghost && (kind === 'glass' || kind === 'glassDark');
    const coloured = !ghost && COLOURED_PARTS.has(kind);
    const arrays = partArrays(chunks, kind, count, glassy, coloured);
    parts[kind] = { count, ...arrays, bounds: instanceBounds(arrays.instanceMatrix, count, boxes.parts[kind]) };
  }
  const furniture: Partial<Record<FurnitureKind, InstanceArrays>> = {};
  // Furniture, only where an interior is drawn: one batch per kind.
  if (!ghost && selection.furniture && chunks.some((c) => c.furniture)) {
    for (const kind of FURNITURE_KINDS) {
      let count = 0;
      for (const chunk of chunks) count += chunk.furniture?.[kind]?.count ?? 0;
      const box = boxes.furniture[kind];
      if (count === 0 || !box) continue;
      const instanceMatrix = furnitureMatrices(chunks, kind, count);
      furniture[kind] = { count, instanceMatrix, bounds: instanceBounds(instanceMatrix, count, box) };
    }
  }
  return { shells, parts, furniture };
}

/** Every array buffer of a batch: handed over, not copied (MDN, `postMessage` transfer). */
export function cellBuffers(arrays: CellArrays): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of Object.values(arrays.shells)) if (s) out.push(s.position.buffer, s.normal.buffer, s.colour.buffer, s.uv.buffer, s.decay.buffer, s.index.buffer, s.bounds.buffer);
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      out.push(p.instanceMatrix.buffer, p.bounds.buffer);
      for (const a of [p.instanceColor, p.litSlot, p.rooms]) if (a) out.push(a.buffer);
    }
  }
  return out as ArrayBuffer[];
}

/** One finish's shells of every chunk in one set of arrays (the vertices concatenated, the indices shifted), or null when none has any. */
function shellArrays(chunks: readonly BuildingChunk[], finish: Finish): Omit<ShellArrays, 'bounds'> | null {
  let vertices = 0;
  let indices = 0;
  for (const chunk of chunks) {
    const part = chunk.shells[finish];
    if (!part) continue;
    vertices += part.position.length / 3;
    indices += part.index.length;
  }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const colour = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const decay = new Float32Array(vertices);
  const index = new Uint32Array(indices);
  let v = 0;
  let n = 0;
  for (const chunk of chunks) {
    const part = chunk.shells[finish];
    if (!part) continue;
    position.set(part.position, v * 3);
    normal.set(part.normal, v * 3);
    colour.set(part.colour, v * 3);
    uv.set(part.uv, v * 2);
    decay.set(part.decay, v);
    for (let i = 0; i < part.index.length; i++) index[n + i] = (part.index[i] as number) + v;
    v += part.position.length / 3;
    n += part.index.length;
  }
  return { position, normal, colour, uv, decay, index };
}

/**
 * A batch's own instance arrays from its chunks, in order: the matrices, the
 * colours of a coloured kind (white where a chunk has none), and a pane's
 * light slot (-1: none) and the room behind it.
 */
function partArrays(chunks: readonly BuildingChunk[], kind: PartKind, count: number, glassy: boolean, coloured: boolean): {
  instanceMatrix: Float32Array; instanceColor?: Float32Array; litSlot?: Float32Array; rooms?: Float32Array;
} {
  const instanceMatrix = new Float32Array(count * 16);
  const instanceColor = coloured ? new Float32Array(count * 3).fill(1) : undefined;
  const litSlot = glassy ? new Float32Array(count) : undefined;
  const rooms = glassy ? new Float32Array(count * ROOM_FLOATS) : undefined;
  let at = 0;
  for (const chunk of chunks) {
    const batch: PartBatch = chunk.parts[kind];
    if (batch.count === 0) continue;
    instanceMatrix.set(batch.matrices, at * 16);
    if (instanceColor && batch.colours) instanceColor.set(batch.colours, at * 3);
    if (litSlot) {
      if (batch.slots) litSlot.set(batch.slots, at);
      else litSlot.fill(-1, at, at + batch.count);
    }
    if (rooms && batch.rooms) rooms.set(batch.rooms, at * ROOM_FLOATS);
    at += batch.count;
  }
  return { instanceMatrix, ...(instanceColor ? { instanceColor } : {}), ...(litSlot ? { litSlot } : {}), ...(rooms ? { rooms } : {}) };
}

/** The furniture of one kind of every chunk, its matrices in chunk order. */
function furnitureMatrices(chunks: readonly BuildingChunk[], kind: FurnitureKind, count: number): Float32Array {
  const matrices = new Float32Array(count * 16);
  let at = 0;
  for (const chunk of chunks) {
    const batch = chunk.furniture?.[kind];
    if (!batch) continue;
    matrices.set(batch.matrices, at * 16);
    at += batch.count;
  }
  return matrices;
}

/**
 * A shell's box and sphere as three's `BufferGeometry.computeBoundingBox` and
 * `computeBoundingSphere` work them out: the box of the vertices, and a
 * sphere round the box's centre as far as the farthest vertex.
 */
export function shellBounds(position: Float32Array): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i]!, y = position[i + 1]!, z = position[i + 2]!;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  let most = 0;
  for (let i = 0; i < position.length; i += 3) {
    const dx = cx - position[i]!, dy = cy - position[i + 1]!, dz = cz - position[i + 2]!;
    most = Math.max(most, dx * dx + dy * dy + dz * dz);
  }
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, Math.sqrt(most));
}

/**
 * An instanced batch's box and sphere as three's `InstancedMesh.computeBoundingBox`
 * works the box out - the geometry's box through each instance's matrix
 * (`Box3.applyMatrix4`: its eight corners), all of them united - and the
 * sphere round that box (`Box3.getBoundingSphere`).
 */
export function instanceBounds(matrices: Float32Array, count: number, box: readonly number[]): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const [bx0, by0, bz0, bx1, by1, bz1] = box as [number, number, number, number, number, number];
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    const e0 = matrices[o]!, e1 = matrices[o + 1]!, e2 = matrices[o + 2]!, e3 = matrices[o + 3]!;
    const e4 = matrices[o + 4]!, e5 = matrices[o + 5]!, e6 = matrices[o + 6]!, e7 = matrices[o + 7]!;
    const e8 = matrices[o + 8]!, e9 = matrices[o + 9]!, e10 = matrices[o + 10]!, e11 = matrices[o + 11]!;
    const e12 = matrices[o + 12]!, e13 = matrices[o + 13]!, e14 = matrices[o + 14]!, e15 = matrices[o + 15]!;
    // The corners in three's order (000, 001, 010, 011, 100, 101, 110, 111), each through the matrix.
    for (let c = 0; c < 8; c++) {
      const x = c & 4 ? bx1 : bx0, y = c & 2 ? by1 : by0, z = c & 1 ? bz1 : bz0;
      const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
      const px = (e0 * x + e4 * y + e8 * z + e12) * w;
      const py = (e1 * x + e5 * y + e9 * z + e13) * w;
      const pz = (e2 * x + e6 * y + e10 * z + e14) * w;
      minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz);
    }
  }
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, (minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5, Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5);
}
