import { FINISHES, type Finish } from '@world/buildings/materials';
import { FURNITURE_KINDS, type FurnitureKind } from '@world/buildings/interior';
import { FACADE_PROP_KINDS } from './facadeProps';
import type { BuildingChunk, PartBatch, PartKind, RunChunk, ShellChunk } from './chunk';
import type { MassingChunk } from './massing';
import { ROOM_FLOATS } from './roomBehind';
import { LOOK_FLOATS, SHELL_PARTS, SHELL_PART_KINDS } from './shellParts';

/** A BATCH OF BUILDINGS AS ARRAYS: what `buildingMesh.ts` `meshesOf` wraps in meshes */

/** Parts drawn with a colour per instance: awnings, the window frames and balcony railings in their building's trim (the materials are white), the shell's parts in their paint. */
export const COLOURED_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['awning', 'frame', 'railing', 'fin', 'louvre', 'brise', ...FACADE_PROP_KINDS, ...SHELL_PART_KINDS]));

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

/** The name of a batch's one shell mesh (`buildingMesh.ts` `meshesOf`), as `fade.ts` and the memory counters find it. */
export const SHELL_MESH = 'building-shell';

/** The finish id of a shell's part per instance, and of a ruin's piece per vertex (`finishes.ts`): its place in `FINISHES`, its layer of the finishes' maps. */
export const FINISH_ATTRIBUTE = 'shellFinish';
/** The shell's vertex attribute of its paint: rgb over `COLOUR_RANGE` and the finish id in w, four unsigned shorts read normalised (`finishes.ts`). */
export const PAINT_ATTRIBUTE = 'shellPaint';

/** A finish's id, as the shell's program reads it. */
export const finishId = (finish: Finish): number => FINISHES.indexOf(finish);

/** The brightest linear colour a shell's paint holds: a light paint shaded up (1.1), the building's own shade (1.05) and the tone (1.03) stay under it. */
export const COLOUR_RANGE = 2;
/** The largest unsigned short: a paint's channel and its finish id over it. */
export const PAINT_UNIT = 65535;
/** The largest signed short: a normal's and a wear's channel over it (WebGL 2: a normalised short reads back as c / 32767). */
export const NORMAL_UNIT = 32767;

/** A linear colour channel as the shell's paint holds it: 16 bits over `COLOUR_RANGE`, a step of 3e-5 (a byte would band the dark paints). */
export const paintShort = (x: number): number => Math.round(Math.max(0, Math.min(1, Math.fround(x) / COLOUR_RANGE)) * PAINT_UNIT);
/** A number in [-1, 1] as a signed short the GPU reads back normalised: the shell's normal and wear. */
export const snorm16 = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * NORMAL_UNIT);

/** Numbers a shell vertex carries in its normal and wear (`normalDecay`) and in its paint (`paint`): four shorts each. */
export const SHELL_SHORTS = 4;

/** A piece of a batch's shells of every finish, one geometry drawn in one call: 28 bytes a vertex, 52 on the far level's runs of bays with openings */
interface ShellArrays {
  readonly position: Float32Array;
  /** The normal (x, y, z) and the wear (w), each a signed short over 32767: the uv is worked out from it and the place (`shellParts.ts` `shellUv`), so it needs more than a byte. */
  readonly normalDecay: Int16Array;
  /** The paint's linear rgb (tone and grime in it) over `COLOUR_RANGE` and the finish id (`PAINT_ATTRIBUTE`), unsigned shorts. */
  readonly paint: Uint16Array;
  /** 16 bits: a piece's vertices fit them (`SHELL_PIECE`), but for a single building larger than that. */
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
  /** The far level's runs of bays with openings only (`RunChunk`): each vertex's bay width and storey height (`FACADE_FLOATS`), its grid (`FACADE_GRID` shorts) and its opening (`FACADE_BYTES`, `facadeLevel.ts`). */
  readonly facade?: Float32Array;
  readonly grid?: Int16Array;
  readonly opening?: Uint8Array;
}

interface InstanceArrays {
  readonly count: number;
  readonly instanceMatrix: Float32Array;
  readonly instanceColor?: Float32Array;
  /** Window panes: each one's light slot (-1: none) and the room behind it. */
  readonly litSlot?: Float32Array;
  readonly rooms?: Uint16Array;
  /** The shell's parts: each one's finish id, wear and ground (`shellParts.ts`). */
  readonly looks?: Float32Array;
  readonly bounds: Bounds;
}

export interface CellArrays {
  /** Every finish's shells in pieces of whole buildings whose vertices fit 16-bit indices, then the far level's runs of bays with openings in pieces of their own; none when the batch takes none or has none. */
  readonly shells: readonly ShellArrays[];
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
  const shells = selection.shells ? [...shellPieces(chunks, (c) => c.shells), ...shellPieces(chunks, (c) => c.runs)] : [];
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
    // The shell's parts read their finish, wear and ground as the shell's vertices do, faded too (`fade.ts`); the preview's ghost reads none.
    const looked = !ghost && SHELL_PARTS.has(kind);
    const arrays = partArrays(chunks, kind, count, glassy, coloured, looked);
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

/** Floats per vertex of the far level's window grid (`buildingMesh.ts` `FacadeStamp`): one bay's width and one storey's height. */
export const FACADE_FLOATS = 2;
/** Shorts per vertex of the far level's window grid, each a whole number: bay and level (u, v, whole at a run's corners), kind + `FACADE_FLIP` where the bays run against the face's own horizontal, volume * 4 + side. */
export const FACADE_GRID = 4;
/** Bytes per vertex of the far level's opening (a0, a1, h0, h1, shares of the bay) its frames' colour (r, g, b) and whether its rooms are offices (255) or homes (0). */
export const FACADE_BYTES = 8;

/** A cell's buildings from afar as one mesh's arrays (`massCells.ts`) */
export interface CellMass {
  readonly position: Float32Array;
  /** Four signed bytes a vertex over 127 (x, y, z, and one left over: no 3-byte format in Direct3D 11): lighting only, no uv worked out from it (the shells' are shorts, `normalDecay`). */
  readonly normal: Int8Array;
  readonly color: Float32Array;
  readonly facade: Float32Array;
  readonly glazing: Float32Array;
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
  readonly top: number;
  /** The tallest thing its level left out, m (`MassingChunk.error`): 0 for a cell's, what a tile's or a plate's choice reads (`massCells.ts`). */
  readonly error: number;
}

/** The index array a cell's mesh needs: 16 bits where its vertices fit (a cell of 240 m mostly does), else 32. */
export function indexArray(vertices: number, indices: number): Uint16Array | Uint32Array {
  return vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
}

/** The masses of a cell's buildings, or a tile's or a plate's (`massLevels.ts`), merged as one set of arrays; null when none has any. */
export function cellMass(masses: readonly MassingChunk[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0;
  for (const c of masses) { vertices += c.position.length / 3; indices += c.index.length; error = Math.max(error, c.error); }
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
  return { position, normal, color, facade, glazing, index, bounds: shellBounds(position), top, error };
}

/** Every buffer of a cell's masses: handed over, not copied. */
export const cellMassBuffers = (c: CellMass): ArrayBuffer[] =>
  [c.position, c.normal, c.color, c.facade, c.glazing, c.index, c.bounds].map((a) => a.buffer as ArrayBuffer);

/** What a batch sends to the GPU, in bytes: every array but the bounds (kept on the page), the kit's shared geometry not counted. */
export function cellBytes(arrays: CellArrays): number {
  let bytes = 0;
  for (const s of arrays.shells) bytes += s.position.byteLength + s.normalDecay.byteLength + s.paint.byteLength + s.index.byteLength + (s.facade?.byteLength ?? 0) + (s.grid?.byteLength ?? 0) + (s.opening?.byteLength ?? 0);
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      bytes += p.instanceMatrix.byteLength;
      for (const a of [p.instanceColor, p.litSlot, p.rooms, p.looks]) if (a) bytes += a.byteLength;
    }
  }
  return bytes;
}

/** Every array buffer of a batch: handed over, not copied (MDN, `postMessage` transfer). */
export function cellBuffers(arrays: CellArrays): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of arrays.shells) {
    out.push(s.position.buffer, s.normalDecay.buffer, s.paint.buffer, s.index.buffer, s.bounds.buffer);
    if (s.facade) out.push(s.facade.buffer);
    if (s.grid) out.push(s.grid.buffer);
    if (s.opening) out.push(s.opening.buffer);
  }
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      out.push(p.instanceMatrix.buffer, p.bounds.buffer);
      for (const a of [p.instanceColor, p.litSlot, p.rooms, p.looks]) if (a) out.push(a.buffer);
    }
  }
  return out as ArrayBuffer[];
}

/** The most vertices a shell piece holds: every index of it fits 16 bits (meshoptimizer's advice: half the index memory and fetch), 65535 left out (WebGL 2.0 spec, "PRIMITIVE_RESTART_FIXED_INDEX is always enabled"). */
export const SHELL_PIECE = 0xffff;

/** A chunk's shell fragments as a piece reads them: the plain ones, or the far level's runs (with their window grid). */
type FragmentsOf = (chunk: BuildingChunk) => Readonly<Partial<Record<Finish, ShellChunk | RunChunk>>> | undefined;

/** The vertices of a chunk's fragments, every finish. */
function chunkVertices(chunk: BuildingChunk, of: FragmentsOf): number {
  let n = 0;
  const fragments = of(chunk);
  if (fragments) for (const finish of FINISHES) n += (fragments[finish]?.position.length ?? 0) / 3;
  return n;
}

/** Every chunk's fragments in pieces, the chunks in order, a piece closed before a chunk would take it past `SHELL_PIECE` vertices (a chunk is never cut: a larger one is a piece alone, with 32-bit indices). */
function shellPieces(chunks: readonly BuildingChunk[], of: FragmentsOf): ShellArrays[] {
  const pieces: ShellArrays[] = [];
  let from = 0, vertices = 0;
  for (let i = 0; i < chunks.length; i++) {
    const n = chunkVertices(chunks[i]!, of);
    if (vertices > 0 && vertices + n > SHELL_PIECE) {
      const piece = shellArrays(chunks.slice(from, i), of);
      if (piece) pieces.push(piece);
      from = i;
      vertices = 0;
    }
    vertices += n;
  }
  const last = shellArrays(chunks.slice(from), of);
  if (last) pieces.push(last);
  return pieces;
}

/** The fragments of every finish of `chunks` in one set of arrays, finish by finish in `FINISHES` order (the chunks' arrays, already in the GPU's layout, concatenated; the indices shifted), or null when none has any. */
function shellArrays(chunks: readonly BuildingChunk[], of: FragmentsOf): ShellArrays | null {
  let vertices = 0;
  let indices = 0;
  let runs = false;
  for (const chunk of chunks) {
    const fragments = of(chunk);
    if (!fragments) continue;
    for (const finish of FINISHES) {
      const part = fragments[finish];
      if (!part) continue;
      vertices += part.position.length / 3;
      indices += part.index.length;
      if ('facade' in part) runs = true;
    }
  }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normalDecay = new Int16Array(vertices * SHELL_SHORTS);
  const paint = new Uint16Array(vertices * SHELL_SHORTS);
  const index = indexArray(vertices, indices);
  const facade = runs ? new Float32Array(vertices * FACADE_FLOATS) : undefined;
  const grid = runs ? new Int16Array(vertices * FACADE_GRID) : undefined;
  const opening = runs ? new Uint8Array(vertices * FACADE_BYTES) : undefined;
  let v = 0;
  let n = 0;
  for (const finish of FINISHES) {
    for (const chunk of chunks) {
      const part = of(chunk)?.[finish];
      if (!part) continue;
      position.set(part.position, v * 3);
      normalDecay.set(part.normalDecay, v * SHELL_SHORTS);
      paint.set(part.paint, v * SHELL_SHORTS);
      if ('facade' in part) {
        facade?.set(part.facade, v * FACADE_FLOATS);
        grid?.set(part.grid, v * FACADE_GRID);
        opening?.set(part.opening, v * FACADE_BYTES);
      }
      for (let i = 0; i < part.index.length; i++) index[n + i] = (part.index[i] as number) + v;
      v += part.position.length / 3;
      n += part.index.length;
    }
  }
  const bounds = shellBounds(position);
  return { position, normalDecay, paint, index, bounds, ...(facade && grid && opening ? { facade, grid, opening } : {}) };
}

/** A number in [-1, 1] as a signed byte the GPU reads back normalised (x / 127, WebGL 2 `vertexAttribPointer`). */
const snorm = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 127);

/** A batch's own instance arrays from its chunks, in order: the matrices, the colours of a coloured kind */
function partArrays(chunks: readonly BuildingChunk[], kind: PartKind, count: number, glassy: boolean, coloured: boolean, looked: boolean): {
  instanceMatrix: Float32Array; instanceColor?: Float32Array; litSlot?: Float32Array; rooms?: Uint16Array; looks?: Float32Array;
} {
  const instanceMatrix = new Float32Array(count * 16);
  const instanceColor = coloured ? new Float32Array(count * 3).fill(1) : undefined;
  const litSlot = glassy ? new Float32Array(count) : undefined;
  const rooms = glassy ? new Uint16Array(count * ROOM_FLOATS) : undefined;
  const looks = looked ? new Float32Array(count * LOOK_FLOATS) : undefined;
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
    if (looks && batch.looks) looks.set(batch.looks, at * LOOK_FLOATS);
    at += batch.count;
  }
  return { instanceMatrix, ...(instanceColor ? { instanceColor } : {}), ...(litSlot ? { litSlot } : {}), ...(rooms ? { rooms } : {}), ...(looks ? { looks } : {}) };
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
