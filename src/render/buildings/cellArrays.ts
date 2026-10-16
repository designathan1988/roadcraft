import { FINISHES, type Finish } from '@world/buildings/materials';
import { FURNITURE_KINDS, type FurnitureKind } from '@world/buildings/interior';
import type { BuildingChunk, PartBatch } from './chunk';
import { FACADE_PROP_KINDS } from './facadeProps';
import type { PartKind } from './kit';
import type { MassingChunk } from './massing';
import { ROOM_FLOATS } from './roomBehind';

/** A BATCH OF BUILDINGS AS ARRAYS: what `buildingMesh.ts` `meshesOf` wraps in meshes */

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

interface ShellArrays {
  readonly position: Float32Array;
  /** The normal (x, y, z) and the wear (w), each a signed byte over 127: four bytes a vertex (`meshesOf` reads both from it). */
  readonly normalDecay: Int8Array;
  readonly colour: Float32Array;
  readonly uv: Float32Array;
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
}

interface InstanceArrays {
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
    // DO NOT colour only the trims there: the material seen with and without instance colours was built again and again
    const coloured = !ghost && (dim || COLOURED_PARTS.has(kind));
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

/** Numbers per vertex of the far level's window grid (`buildingMesh.ts` `FacadeStamp`): bay and level (u, v), bay width and storey height, kind, volume * 4 + side, the facade's direction along (world plan). */
export const FACADE_FLOATS = 8;
/** Bytes per vertex of the far level's opening (a0, a1, h0, h1, shares of the bay) its frames' colour (r, g, b) and whether its rooms are offices (255) or homes (0). */
export const FACADE_BYTES = 8;

/** One finish of a cell's far level (L1): the shell's arrays, and each vertex's window grid for the shader (`facadeLevel.ts`). */
export interface FacadeArrays extends ShellArrays {
  readonly facade: Float32Array;
  readonly opening: Uint8Array;
}

/** A cell's far level (L1), by finish: its buildings emitted again as runs of bays (`emitChunk` `far`). */
export type CellFacade = Readonly<Partial<Record<Finish, FacadeArrays>>>;

/** The far level of `chunks` (emitted `far`) as one set of arrays per finish; null when none has a shell. */
export function cellFacade(chunks: readonly BuildingChunk[]): CellFacade | null {
  const out: Partial<Record<Finish, FacadeArrays>> = {};
  let any = false;
  for (const finish of FINISHES) {
    const shell = shellArrays(chunks, finish);
    if (!shell) continue;
    const vertices = shell.position.length / 3;
    const facade = new Float32Array(vertices * FACADE_FLOATS);
    const opening = new Uint8Array(vertices * FACADE_BYTES);
    let v = 0;
    for (const chunk of chunks) {
      const part = chunk.shells[finish];
      if (!part) continue;
      if (part.facade) facade.set(part.facade, v * FACADE_FLOATS);
      if (part.opening) opening.set(part.opening, v * FACADE_BYTES);
      v += part.position.length / 3;
    }
    out[finish] = { ...shell, bounds: shellBounds(shell.position), facade, opening };
    any = true;
  }
  return any ? out : null;
}

/** Every buffer of a cell's far level: handed over, not copied. */
export function cellFacadeBuffers(f: CellFacade): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of Object.values(f)) if (s) out.push(s.position.buffer, s.normalDecay.buffer, s.colour.buffer, s.uv.buffer, s.index.buffer, s.bounds.buffer, s.facade.buffer, s.opening.buffer);
  return out as ArrayBuffer[];
}

/** A cell's buildings from afar as one mesh's arrays (`massCells.ts`) */
export interface CellMass {
  readonly position: Float32Array;
  /** Four signed bytes a vertex over 127 (x, y, z, and one left over: no 3-byte format in Direct3D 11), as the shells' (`normalDecay`). */
  readonly normal: Int8Array;
  readonly color: Float32Array;
  readonly facade: Float32Array;
  readonly glazing: Float32Array;
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
  readonly top: number;
}

/** The index array a cell's mesh needs: 16 bits where its vertices fit (a cell of 240 m mostly does), else 32. */
export function indexArray(vertices: number, indices: number): Uint16Array | Uint32Array {
  return vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
}

/** The masses of a cell's buildings as one set of arrays; null when none has any. */
export function cellMass(masses: readonly MassingChunk[]): CellMass | null {
  let vertices = 0, indices = 0;
  for (const c of masses) { vertices += c.position.length / 3; indices += c.index.length; }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Int8Array(vertices * 4), color = new Float32Array(vertices * 3);
  const facade = new Float32Array(vertices * 4), glazing = new Float32Array(vertices * 2), index = indexArray(vertices, indices);
  let v = 0, n = 0, top = -Infinity;
  for (const c of masses) {
    position.set(c.position, v * 3);
    for (let k = 0, count = c.position.length / 3; k < count; k++) {
      normal[(v + k) * 4] = snorm(c.normal[k * 3]!); normal[(v + k) * 4 + 1] = snorm(c.normal[k * 3 + 1]!); normal[(v + k) * 4 + 2] = snorm(c.normal[k * 3 + 2]!);
    }
    color.set(c.colour, v * 3);
    facade.set(c.facade, v * 4);
    glazing.set(c.glazing, v * 2);
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    for (let i = 1; i < c.position.length; i += 3) top = Math.max(top, c.position[i]!);
    v += c.position.length / 3;
    n += c.index.length;
  }
  return { position, normal, color, facade, glazing, index, bounds: shellBounds(position), top };
}

/** Every buffer of a cell's masses: handed over, not copied. */
export const cellMassBuffers = (c: CellMass): ArrayBuffer[] =>
  [c.position, c.normal, c.color, c.facade, c.glazing, c.index, c.bounds].map((a) => a.buffer as ArrayBuffer);

/** What a batch sends to the GPU, in bytes: every array but the bounds (kept on the page), the kit's shared geometry not counted. */
export function cellBytes(arrays: CellArrays): number {
  let bytes = 0;
  for (const s of Object.values(arrays.shells)) if (s) bytes += s.position.byteLength + s.normalDecay.byteLength + s.colour.byteLength + s.uv.byteLength + s.index.byteLength;
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      bytes += p.instanceMatrix.byteLength;
      for (const a of [p.instanceColor, p.litSlot, p.rooms]) if (a) bytes += a.byteLength;
    }
  }
  return bytes;
}

/** Every array buffer of a batch: handed over, not copied (MDN, `postMessage` transfer). */
export function cellBuffers(arrays: CellArrays): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of Object.values(arrays.shells)) if (s) out.push(s.position.buffer, s.normalDecay.buffer, s.colour.buffer, s.uv.buffer, s.index.buffer, s.bounds.buffer);
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
  // DO NOT keep them as floats: 16 bytes a vertex of the town's largest geometry for what a byte each tells (normals of flat walls, a wear level).
  const normalDecay = new Int8Array(vertices * 4);
  const colour = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const index = indexArray(vertices, indices);
  let v = 0;
  let n = 0;
  for (const chunk of chunks) {
    const part = chunk.shells[finish];
    if (!part) continue;
    position.set(part.position, v * 3);
    const count = part.position.length / 3;
    for (let k = 0; k < count; k++) {
      const at = (v + k) * 4;
      normalDecay[at] = snorm(part.normal[k * 3]!); normalDecay[at + 1] = snorm(part.normal[k * 3 + 1]!); normalDecay[at + 2] = snorm(part.normal[k * 3 + 2]!);
      normalDecay[at + 3] = snorm(part.decay[k]!);
    }
    colour.set(part.colour, v * 3);
    uv.set(part.uv, v * 2);
    for (let i = 0; i < part.index.length; i++) index[n + i] = (part.index[i] as number) + v;
    v += part.position.length / 3;
    n += part.index.length;
  }
  return { position, normalDecay, colour, uv, index };
}

/** A number in [-1, 1] as a signed byte the GPU reads back normalised (x / 127, WebGL 2 `vertexAttribPointer`). */
const snorm = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 127);

/** A batch's own instance arrays from its chunks, in order: the matrices, the colours of a coloured kind */
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

/** A shell's box and sphere as three's `BufferGeometry.computeBoundingBox` and `computeBoundingSphere` work them out */
function shellBounds(position: Float32Array): Bounds {
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

/** An instanced batch's box and sphere as three's `InstancedMesh.computeBoundingBox` works the box out */
function instanceBounds(matrices: Float32Array, count: number, box: readonly number[]): Bounds {
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
