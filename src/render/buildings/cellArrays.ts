import { least, most } from '@core/minMax';
import { DataUtils } from 'three';
import { CELL } from '@world/cells';
import { FINISHES, type Finish } from '@world/buildings/materials';
import { FURNITURE_KINDS, type FurnitureKind } from '@world/buildings/interior';
import { FACADE_PROP_KINDS } from './facadeProps';
import type { BuildingChunk, PartBatch, PartKind, RunChunk, ShellChunk } from './chunk';
import type { MassingChunk } from './massing';
import { ROOM_FLOATS } from './roomBehind';
import { LOOK_FLOATS, SHELL_PARTS, SHELL_PART_KINDS } from './shellParts';
import { POSE_FLOATS, poseMatrixInto } from './partPose';

/** A BATCH OF BUILDINGS AS ARRAYS: what `buildingMesh.ts` `meshesOf` wraps in meshes */

/** Parts drawn with a colour per instance: awnings, the window frames and balcony railings in their building's trim (the materials are white), the shell's parts in their paint. */
export const COLOURED_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['awning', 'frame', 'railing', 'fin', 'louvre', 'brise', ...FACADE_PROP_KINDS, ...SHELL_PART_KINDS]));

/** What filing a kind reads of its screen (`kit.ts` `PartScreen`), sent with each job (`kitBoxes`): its first coarser level's error, its box (the kit's `Axes`), its finest level's triangles. Here, not in `partFiling.ts`: the batches' boxes carry it, and the filing reads the batches. */
export interface PartBanding {
  readonly first: readonly [number, number, number] | null;
  readonly extent: readonly [number, number, number];
  readonly triangles: number;
}
export type PartBandings = Readonly<Record<PartKind, PartBanding>>;

/** What a batch takes: the part kinds, whether the shells and the furniture; the preview's look (`ghost`) or the faded one (`dim`). */
export interface CellSelection {
  readonly parts: readonly PartKind[];
  readonly shells: boolean;
  readonly furniture: boolean;
  readonly ghost: boolean;
  readonly dim: boolean;
  /** The far level's cell (its column and row, `BATCH_CELL`): its shells' places quantized on the cell's grid (`ShellGrid`); none: in floats (the detail's millimetre steps). */
  readonly grid?: readonly [number, number];
}

/** A cell's grid its far level's shells are laid on (`cellShellGrid`): one origin and one step for every piece of the cell, so a corner two pieces share is one point of it, bit for bit. */
export interface ShellGrid {
  /** The grid's origin, three's axes. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Metres a step: every axis alike (the mesh's scale is uniform, so its normals stay as they are). */
  readonly step: number;
}
/** How far past its cell a cell's buildings may reach on its grid, m. */
export const SHELL_GRID_MARGIN = 64;
/** The grid's step: the cell and its margins in an unsigned short, 5.9 mm (a point within 2.9 mm, a hundredth of the far level's 0.3 m). */
export const SHELL_GRID_STEP = (CELL + 2 * SHELL_GRID_MARGIN) / 65535;

/** A cell's grid, its height from the lowest of its shells. */
export const cellShellGrid = (i: number, j: number, lowest: number): ShellGrid =>
  ({ x: i * CELL - SHELL_GRID_MARGIN, y: lowest, z: -(j + 1) * CELL - SHELL_GRID_MARGIN, step: SHELL_GRID_STEP });

/** Pieces with their places on a grid: four unsigned shorts a vertex (the fourth left over: no 3-short format in Direct3D 11); null where a point falls off it (the cell keeps its floats). */
function onGrid(pieces: readonly ShellArrays[], grid: ShellGrid): ShellArrays[] | null {
  const out: ShellArrays[] = [];
  for (const piece of pieces) {
    const p = piece.position as Float32Array, n = p.length / 3;
    const q = new Uint16Array(n * 4);
    for (let v = 0; v < n; v++) {
      for (let k = 0; k < 3; k++) {
        const s = Math.round((p[v * 3 + k]! - (k === 0 ? grid.x : k === 1 ? grid.y : grid.z)) / grid.step);
        if (!(s >= 0 && s <= 65535)) return null;
        q[v * 4 + k] = s;
      }
    }
    out.push({ ...piece, position: q, place: grid });
  }
  return out;
}

/** A box and a sphere: minX, minY, minZ, maxX, maxY, maxZ, then centre x, y, z and radius (three's `Box3` and `Sphere`). */
export type Bounds = Float64Array;

/** The name of a batch's one shell mesh (`buildingMesh.ts` `meshesOf`), as `fade.ts` and the memory counters find it. */
export const SHELL_MESH = 'building-shell';

/** The finish id of a shell's part per instance, and of a ruin's piece per vertex (`finishes.ts`): its place in `FINISHES`, its layer of the finishes' maps. */
export const FINISH_ATTRIBUTE = 'shellFinish';
/** The shell's vertex attribute of its normal, octahedral (`octNormal`): two shorts read normalised (`finishes.ts`). */
export const SHELL_NORMAL = 'shellOctNormal';
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

/** Numbers a shell vertex carries in its paint (`paint`): four shorts, rgb and its finish with its wear (`finishWear`). */
export const SHELL_SHORTS = 4;
/** Numbers a shell vertex carries in its normal (`normal`): two signed shorts, octahedral (`octNormal`). */
export const NORMAL_SHORTS = 2;
/** A wear's steps in the paint's fourth short (`finishWear`): its high byte. */
export const WEAR_STEPS = 255;

/** A wear (0..1) as the shell carries it: a byte's step, `WEAR_STEPS`. */
export const wearByte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * WEAR_STEPS);
/** The paint's fourth short: the finish id in its low byte, the wear's byte over it (`finishes.ts` reads both back). */
export const finishWear = (finish: number, wear: number): number => finish + 256 * wearByte(wear);

/** A unit normal as two signed shorts, octahedral (Cigolle et al. 2014, "A Survey of Efficient Representations for Independent Unit Vectors"): 4 bytes, to 1e-4 rad. */
export function octNormal(x: number, y: number, z: number, out: Int16Array, at: number): void {
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / sum, v = y / sum;
  if (z < 0) {
    const su = u >= 0 ? 1 : -1, sv = v >= 0 ? 1 : -1;
    const nu = (1 - Math.abs(v)) * su, nv = (1 - Math.abs(u)) * sv;
    u = nu; v = nv;
  }
  out[at] = snorm16(u); out[at + 1] = snorm16(v);
}

/** A normal back from its two shorts, as the shell's program reads it (`finishes.ts` `shellOctNormal`). */
export function octDecode(a: number, b: number): [number, number, number] {
  let x = Math.max(-1, a / NORMAL_UNIT), y = Math.max(-1, b / NORMAL_UNIT);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) { const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1), ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1); x = nx; y = ny; }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** A piece of a batch's shells of every finish, one geometry drawn in one call: 24 bytes a vertex, 44 on the far level's runs of bays with openings */
interface ShellArrays {
  /** Floats, or on its cell's grid (`place`): four unsigned shorts, read normalised and put in place by the mesh's matrix. */
  readonly position: Float32Array | Uint16Array;
  readonly place?: ShellGrid;
  /** The normal, octahedral in two signed shorts (`octNormal`): the uv is worked out from it and the place (`shellParts.ts` `shellUv`), so it needs more than a byte. */
  readonly normal: Int16Array;
  /** The paint's linear rgb (tone and grime in it) over `COLOUR_RANGE`, and the finish id with the wear (`finishWear`, `PAINT_ATTRIBUTE`), unsigned shorts. */
  readonly paint: Uint16Array;
  /** 16 bits: a piece's vertices fit them (`SHELL_PIECE`), but for a single building larger than that. */
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
  /** The far level's runs of bays with openings only (`RunChunk`): each vertex's bay width and storey height (`FACADE_FLOATS`), its grid (`FACADE_GRID` shorts) and its opening (`FACADE_BYTES`, `facadeLevel.ts`). */
  readonly facade?: Uint16Array;
  readonly grid?: Int16Array;
  readonly opening?: Uint8Array;
}

interface InstanceArrays {
  readonly count: number;
  readonly poses: Float32Array;
  /** Each instance's tint, linear rgb in half floats (`HALF_FLOAT`): 6 bytes, not 12. */
  readonly instanceColor?: Uint16Array;
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
  /** What filing a cell's parts by band reads of each kind's screen, as the kit has them now (`partFiling.ts`). */
  readonly bandings?: PartBandings;
}

/** The batch of `chunks` that `selection` takes, as arrays. */
/** `groups`: each chunk's square (`cellWork.ts` gives the shells quadrants of two detail cells), its shells then pieced square by square: each piece's box that square's, so three leaves out of the view and out of each sun cascade the squares outside them (a piece of buildings from across the whole cell was drawn whole for a corner of it in view). */
export function cellArrays(chunks: readonly BuildingChunk[], selection: CellSelection, boxes: KitBoxes, groups?: readonly string[]): CellArrays {
  const { ghost, dim } = selection;
  const floats = selection.shells ? [...shellPieces(chunks, (c) => c.shells, groups), ...shellPieces(chunks, (c) => c.runs, groups)] : [];
  // The far level's: on its cell's grid, its height from its lowest point (`ShellGrid`).
  let lowest = Infinity;
  for (const piece of floats) lowest = Math.min(lowest, piece.bounds[1]!);
  const shells = selection.grid && floats.length ? onGrid(floats, cellShellGrid(selection.grid[0], selection.grid[1], lowest)) ?? floats : floats;
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
    parts[kind] = { count, ...arrays, bounds: instanceBounds(arrays.poses, count, boxes.parts[kind]) };
  }
  const furniture: Partial<Record<FurnitureKind, InstanceArrays>> = {};
  // Furniture, only where an interior is drawn: one batch per kind.
  if (!ghost && selection.furniture && chunks.some((c) => c.furniture)) {
    for (const kind of FURNITURE_KINDS) {
      let count = 0;
      for (const chunk of chunks) count += chunk.furniture?.[kind]?.count ?? 0;
      const box = boxes.furniture[kind];
      if (count === 0 || !box) continue;
      const poses = furniturePoses(chunks, kind, count);
      furniture[kind] = { count, poses, bounds: instanceBounds(poses, count, box) };
    }
  }
  return { shells, parts, furniture };
}

/** Half floats per vertex of the far level's window grid (`buildingMesh.ts` `FacadeStamp`): one bay's width and one storey's height, to a millimetre or two. */
export const FACADE_FLOATS = 2;
/** Shorts per vertex of the far level's window grid, each a whole number: bay and level (u, v, whole at a run's corners), kind + `FACADE_FLIP` where the bays run against the face's own horizontal, volume * 4 + side. */
export const FACADE_GRID = 4;
/** Bytes per vertex of the far level's opening (a0, a1, h0, h1, shares of the bay) its frames' colour (r, g, b) and whether its rooms are offices (255) or homes (0). */
export const FACADE_BYTES = 8;

/** A cell's buildings from afar as one mesh's arrays (`massCells.ts`) */
export interface CellMass {
  /** Floats, or on its square's grid (`place`, `massGrid`): four unsigned shorts, read normalised and put in place by the mesh's matrix. */
  readonly position: Float32Array | Uint16Array;
  readonly place?: ShellGrid;
  /** Four signed bytes a vertex over 127 (x, y, z, and one left over: no 3-byte format in Direct3D 11): lighting only, no uv worked out from it (the shells' are shorts, `normal`). */
  readonly normal: Int8Array;
  /** Linear rgb and a fourth left over, half floats (`HALF_FLOAT`, `massCells.ts` `cellMesh`): 11 bits of mantissa, more than a colour shows. */
  readonly color: Uint16Array;
  /** Along its face and its windows' first storey's foot, m: the long and the high, full floats (`MASS_FACADE`). */
  readonly facade: Float32Array;
  /** Its bay's width and storey's height and its glass share, and a fourth left over, half floats (`MASS_GRID`). */
  readonly grid: Uint16Array;
  /** Its rooms' seed (the lot of each lit window, `massingMaterial.ts`) and the office flag over it: a full float, a seed's fraction kept whole. */
  readonly seed: Float32Array;
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

/** A square of cells a level's masses stand in (`levelKeys.ts`): its first column and row and its side in cells. */
export interface MassSquare { readonly i0: number; readonly j0: number; readonly n: number }

/** A square's grid for its masses (as `cellShellGrid` for a cell's shells): the square and its margins in an unsigned short, every axis alike, its height from its lowest point; a cell's step 5.9 mm, a tile's 18 mm, a plate's 33 mm (a point within half of it, a hundredth of the level's error). */
export function massGrid(square: MassSquare, lowest: number): ShellGrid {
  const span = square.n * CELL + 2 * SHELL_GRID_MARGIN;
  return { x: square.i0 * CELL - SHELL_GRID_MARGIN, y: lowest, z: -(square.j0 + square.n) * CELL - SHELL_GRID_MARGIN, step: span / 65535 };
}

/** A mass's places in floats, as the GPU reads them back (from its grid, if on one). */
export function massPlaces(mass: CellMass): Float32Array {
  const place = mass.place;
  if (!place) return mass.position as Float32Array;
  const q = mass.position as Uint16Array, n = q.length / 4, out = new Float32Array(n * 3), span = Math.fround(place.step * 65535);
  for (let v = 0; v < n; v++) {
    out[v * 3] = Math.fround(Math.fround(q[v * 4]! / 65535) * span) + Math.fround(place.x);
    out[v * 3 + 1] = Math.fround(Math.fround(q[v * 4 + 1]! / 65535) * span) + Math.fround(place.y);
    out[v * 3 + 2] = Math.fround(Math.fround(q[v * 4 + 2]! / 65535) * span) + Math.fround(place.z);
  }
  return out;
}

/** A mass's places in floats put on its square's grid; the mass as it was where a point falls off it. */
export function massOnGrid(mass: CellMass, square: MassSquare): CellMass {
  const p = massPlaces(mass), n = p.length / 3;
  const grid = massGrid(square, mass.bounds[1]!);
  const q = new Uint16Array(n * 4);
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 3; k++) {
      const s = Math.round((p[v * 3 + k]! - (k === 0 ? grid.x : k === 1 ? grid.y : grid.z)) / grid.step);
      if (!(s >= 0 && s <= 65535)) return mass;
      q[v * 4 + k] = s;
    }
  }
  return { ...mass, position: q, place: grid };
}

/** The masses of a cell's buildings, or a tile's or a plate's (`massLevels.ts`), merged as one set of arrays, on `square`'s grid when given (`massGrid`); null when none has any. */
export function cellMass(masses: readonly MassingChunk[], square?: MassSquare): CellMass | null {
  const merged = mergedMass(masses);
  return merged && square ? massOnGrid(merged, square) : merged;
}

/** The masses merged, their places in floats. */
function mergedMass(masses: readonly MassingChunk[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0;
  for (const c of masses) { vertices += c.position.length / 3; indices += c.index.length; error = Math.max(error, c.error); }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3), normal = new Int8Array(vertices * 4), color = new Uint16Array(vertices * 4);
  const facade = new Float32Array(vertices * MASS_FACADE), grid = new Uint16Array(vertices * MASS_GRID), seed = new Float32Array(vertices), index = indexArray(vertices, indices);
  let v = 0, n = 0, top = -Infinity;
  for (const c of masses) {
    position.set(c.position, v * 3);
    for (let k = 0, count = c.position.length / 3; k < count; k++) {
      const at = v + k;
      normal[at * 4] = snorm(c.normal[k * 3]!); normal[at * 4 + 1] = snorm(c.normal[k * 3 + 1]!); normal[at * 4 + 2] = snorm(c.normal[k * 3 + 2]!);
      for (let ch = 0; ch < 3; ch++) color[at * 4 + ch] = DataUtils.toHalfFloat(c.colour[k * 3 + ch]!);
      // The chunk's facade (along, bay, storey, foot) and glazing (share, seed), split by what each needs.
      facade[at * MASS_FACADE] = c.facade[k * 4]!; facade[at * MASS_FACADE + 1] = c.facade[k * 4 + 3]!;
      grid[at * MASS_GRID] = DataUtils.toHalfFloat(c.facade[k * 4 + 1]!); grid[at * MASS_GRID + 1] = DataUtils.toHalfFloat(c.facade[k * 4 + 2]!);
      grid[at * MASS_GRID + 2] = DataUtils.toHalfFloat(c.glazing[k * 2]!);
      seed[at] = c.glazing[k * 2 + 1]!;
    }
    for (let i = 0; i < c.index.length; i++) index[n + i] = c.index[i]! + v;
    for (let i = 1; i < c.position.length; i += 3) top = Math.max(top, c.position[i]!);
    v += c.position.length / 3;
    n += c.index.length;
  }
  return { position, normal, color, facade, grid, seed, index, bounds: shellBounds(position), top, error };
}

/** A mass vertex's numbers: its facade's full floats, its grid's half floats (`CellMass`): 44 bytes a vertex with its place, normal, colour and seed (52 in full floats). */
export const MASS_FACADE = 2;
export const MASS_GRID = 4;

/** Every buffer of a cell's masses: handed over, not copied. */
export const cellMassBuffers = (c: CellMass): ArrayBuffer[] =>
  [c.position, c.normal, c.color, c.facade, c.grid, c.seed, c.index, c.bounds].map((a) => a.buffer as ArrayBuffer);

/** Numbers a box of a box level is drawn from (`massBoxes.ts`): centre x, y, half sides, turn; wall's foot, top, floor; wall rgb, bay; roof rgb, storey; glass share, seed. */
export const BOX_INSTANCE = 18;

/** A BOX LEVEL'S BUILDINGS AS INSTANCES OF ONE BOX (`farTiles.ts` levels 2 and up): `BOX_INSTANCE` numbers a box in place of its 20 vertices and 30 indices. */
export interface BoxMass {
  readonly boxes: Float32Array;
  readonly bounds: Bounds;
  readonly top: number;
  readonly error: number;
}

/** A far level's masses: a mesh's arrays, or boxes to instance. */
export type FarMass = CellMass | BoxMass;
export const isBoxMass = (m: FarMass): m is BoxMass => 'boxes' in m;
/** Every buffer of a far level's masses: handed over, not copied. */
export const farMassBuffers = (m: FarMass): ArrayBuffer[] => (isBoxMass(m) ? [m.boxes.buffer as ArrayBuffer, m.bounds.buffer as ArrayBuffer] : cellMassBuffers(m));

/** What a batch sends to the GPU, in bytes: every array but the bounds (kept on the page), the kit's shared geometry not counted. */
export function cellBytes(arrays: CellArrays): number {
  let bytes = 0;
  for (const s of arrays.shells) bytes += s.position.byteLength + s.normal.byteLength + s.paint.byteLength + s.index.byteLength + (s.facade?.byteLength ?? 0) + (s.grid?.byteLength ?? 0) + (s.opening?.byteLength ?? 0);
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      bytes += p.poses.byteLength;
      for (const a of [p.instanceColor, p.litSlot, p.rooms, p.looks]) if (a) bytes += a.byteLength;
    }
  }
  return bytes;
}

/** Every array buffer of a batch: handed over, not copied (MDN, `postMessage` transfer). */
export function cellBuffers(arrays: CellArrays): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of arrays.shells) {
    out.push(s.position.buffer, s.normal.buffer, s.paint.buffer, s.index.buffer, s.bounds.buffer);
    if (s.facade) out.push(s.facade.buffer);
    if (s.grid) out.push(s.grid.buffer);
    if (s.opening) out.push(s.opening.buffer);
  }
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      out.push(p.poses.buffer, p.bounds.buffer);
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
function shellPieces(chunks: readonly BuildingChunk[], of: FragmentsOf, groups?: readonly string[]): ShellArrays[] {
  // By group: each group's chunks in their order, the groups in the order they first come (the same chunks make the same pieces, `buildingMesh.ts` refill).
  if (groups) {
    const byGroup = new Map<string, BuildingChunk[]>();
    chunks.forEach((chunk, i) => { const key = groups[i]!; const list = byGroup.get(key); if (list) list.push(chunk); else byGroup.set(key, [chunk]); });
    if (byGroup.size > 1) return [...byGroup.values()].flatMap((list) => shellPieces(list, of));
  }
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
  const normal = new Int16Array(vertices * NORMAL_SHORTS);
  const paint = new Uint16Array(vertices * SHELL_SHORTS);
  const index = indexArray(vertices, indices);
  const facade = runs ? new Uint16Array(vertices * FACADE_FLOATS) : undefined;
  const grid = runs ? new Int16Array(vertices * FACADE_GRID) : undefined;
  const opening = runs ? new Uint8Array(vertices * FACADE_BYTES) : undefined;
  let v = 0;
  let n = 0;
  for (const finish of FINISHES) {
    for (const chunk of chunks) {
      const part = of(chunk)?.[finish];
      if (!part) continue;
      position.set(part.position, v * 3);
      normal.set(part.normal, v * NORMAL_SHORTS);
      paint.set(part.paint, v * SHELL_SHORTS);
      if ('facade' in part) {
        facade?.set(part.facade, v * FACADE_FLOATS);
        grid?.set(part.grid, v * FACADE_GRID);
        opening?.set(part.opening, v * FACADE_BYTES);
      }
      offsetIndices(index, n, part.index, v);
      v += part.position.length / 3;
      n += part.index.length;
    }
  }
  const bounds = shellBounds(position);
  return { position, normal, paint, index, bounds, ...(facade && grid && opening ? { facade, grid, opening } : {}) };
}

/** 1 in half float: an instance with no tint of its own. */
const HALF_ONE = DataUtils.toHalfFloat(1);

/** A number in [-1, 1] as a signed byte the GPU reads back normalised (x / 127, WebGL 2 `vertexAttribPointer`). */
const snorm = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 127);

/** A batch's own instance arrays from its chunks, in order: the matrices, the colours of a coloured kind */
function partArrays(chunks: readonly BuildingChunk[], kind: PartKind, count: number, glassy: boolean, coloured: boolean, looked: boolean): {
  poses: Float32Array; instanceColor?: Uint16Array; litSlot?: Float32Array; rooms?: Uint16Array; looks?: Float32Array;
} {
  const poses = new Float32Array(count * POSE_FLOATS);
  const instanceColor = coloured ? new Uint16Array(count * 3).fill(HALF_ONE) : undefined;
  const litSlot = glassy ? new Float32Array(count) : undefined;
  const rooms = glassy ? new Uint16Array(count * ROOM_FLOATS) : undefined;
  const looks = looked ? new Float32Array(count * LOOK_FLOATS) : undefined;
  let at = 0;
  for (const chunk of chunks) {
    const batch: PartBatch = chunk.parts[kind];
    if (batch.count === 0) continue;
    poses.set(batch.poses, at * POSE_FLOATS);
    if (instanceColor && batch.colours) for (let k = 0; k < batch.count * 3; k++) instanceColor[at * 3 + k] = DataUtils.toHalfFloat(batch.colours[k]!);
    if (litSlot) {
      if (batch.slots) litSlot.set(batch.slots, at);
      else litSlot.fill(-1, at, at + batch.count);
    }
    if (rooms && batch.rooms) rooms.set(batch.rooms, at * ROOM_FLOATS);
    if (looks && batch.looks) looks.set(batch.looks, at * LOOK_FLOATS);
    at += batch.count;
  }
  return { poses, ...(instanceColor ? { instanceColor } : {}), ...(litSlot ? { litSlot } : {}), ...(rooms ? { rooms } : {}), ...(looks ? { looks } : {}) };
}

/** The furniture of one kind of every chunk, its poses in chunk order. */
function furniturePoses(chunks: readonly BuildingChunk[], kind: FurnitureKind, count: number): Float32Array {
  const poses = new Float32Array(count * POSE_FLOATS);
  let at = 0;
  for (const chunk of chunks) {
    const batch = chunk.furniture?.[kind];
    if (!batch) continue;
    poses.set(batch.poses, at * POSE_FLOATS);
    at += batch.count;
  }
  return poses;
}

/** A fragment's indices written into `out` at `at`, each `add` more (its vertices' place in the merged arrays): a loop of its own, DO NOT inline it in `shellArrays` (entered on the stack, its code left at every fragment's end, 205 times a job). */
function offsetIndices(out: Uint16Array | Uint32Array, at: number, from: ArrayLike<number>, add: number): void {
  for (let i = 0; i < from.length; i++) out[at + i] = from[i]! + add;
}

/** What `shellBounds`'s loops write: the box (min x, y, z, max x, y, z) and the farthest squared distance from its centre. */
const SHELL_BOX = new Float64Array(7);

/** A shell's box and sphere as three's `BufferGeometry.computeBoundingBox` and `computeBoundingSphere` work them out */
/** DO NOT work the box's centre and radius out after its loops in one function: entered on the stack (OSR), its code never saw them run and left there for each shell (`instanceBounds`). */
export function shellBounds(position: Float32Array): Bounds {
  boxOfPoints(position, SHELL_BOX);
  const minX = SHELL_BOX[0]!, minY = SHELL_BOX[1]!, minZ = SHELL_BOX[2]!, maxX = SHELL_BOX[3]!, maxY = SHELL_BOX[4]!, maxZ = SHELL_BOX[5]!;
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  farthestFrom(position, cx, cy, cz, SHELL_BOX);
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, Math.sqrt(SHELL_BOX[6]!));
}

/** The box of the points, written into `out` after each one. */
function boxOfPoints(position: Float32Array, out: Float64Array): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i]!, y = position[i + 1]!, z = position[i + 2]!;
    minX = least(minX, x); minY = least(minY, y); minZ = least(minZ, z);
    maxX = most(maxX, x); maxY = most(maxY, y); maxZ = most(maxZ, z);
    out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  }
}

/** The farthest squared distance of the points from (cx, cy, cz), written into `out[6]` after each one. */
function farthestFrom(position: Float32Array, cx: number, cy: number, cz: number, out: Float64Array): void {
  let far = 0;
  out[6] = far;
  for (let i = 0; i < position.length; i += 3) {
    const dx = cx - position[i]!, dy = cy - position[i + 1]!, dz = cz - position[i + 2]!;
    far = most(far, dx * dx + dy * dy + dz * dz);
    out[6] = far;
  }
}

/** One instance's matrix, written over by each instance `instanceBounds` reads. */
const BOUNDS_MATRIX = new Float32Array(16);
/** The box `boxOfInstances` widens: min x, y, z, max x, y, z. */
const BOUNDS_BOX = new Float64Array(6);

/** An instanced batch's box and sphere as three's `InstancedMesh.computeBoundingBox` works the box out */
/** DO NOT end the loop over the instances with the box's sums in the same function: entered on the stack (OSR) on its first long batch, its code never saw the sums run and left on them for every batch after (138 times a job), each batch's start run unoptimised, every number boxed. */
function instanceBounds(poses: Float32Array, count: number, box: readonly number[]): Bounds {
  boxOfInstances(poses, count, box, BOUNDS_BOX);
  const minX = BOUNDS_BOX[0]!, minY = BOUNDS_BOX[1]!, minZ = BOUNDS_BOX[2]!, maxX = BOUNDS_BOX[3]!, maxY = BOUNDS_BOX[4]!, maxZ = BOUNDS_BOX[5]!;
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, (minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5, Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5);
}

/** The box of every instance's corners, written into `out` (min x, y, z, max x, y, z) after each instance: nothing after the loop for its code to have never run. */
function boxOfInstances(poses: Float32Array, count: number, box: readonly number[], out: Float64Array): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  const [bx0, by0, bz0, bx1, by1, bz1] = box as [number, number, number, number, number, number];
  const matrices = BOUNDS_MATRIX, o = 0;
  for (let i = 0; i < count; i++) {
    // Each instance's matrix as the GPU makes it from its pose (`partPose.ts`).
    poseMatrixInto(poses, i * POSE_FLOATS, matrices, 0);
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
      // Comparisons, not the built-ins: each `Math.min` here was a call and a boxed result (`core/minMax.ts`).
      minX = least(minX, px); minY = least(minY, py); minZ = least(minZ, pz);
      maxX = most(maxX, px); maxY = most(maxY, py); maxZ = most(maxZ, pz);
    }
    out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  }
}
