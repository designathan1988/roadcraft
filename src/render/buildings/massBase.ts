import earcut from 'earcut';
import { resolveBlocks } from '@world/buildings/blocks';
import type { GroundAt } from '@world/buildings/foundation';
import { localFootprint } from '@world/buildings/footprints';
import { buildingFrame, closedBlocks, frameX, frameY, roofRise, volumeElevation, volumeHeight } from '@world/buildings/geometry';
import { type Finish, roofMaterial, wallMaterial } from '@world/buildings/materials';
import type { Building, Volume } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';
import { type Bounds, type MassSquare, type ShellGrid, indexArray, massGrid, shellBounds } from './cellArrays';
import { BURY, LOT_COLOURS, type Rgb, TERRACE_RGB, massColours, rgbOf } from './massing';

/**
 * THE BUILDINGS' TOP LEVEL (the base, above the plates): every building of a plate's square as the prisms of its real blocks - each
 * block's own footprint stood from its floor to its eaves (a pitched roof flat at half its rise), its paved lots flat - merged into one
 * mesh a square, in the leanest vertex a mass can have: four unsigned shorts, its place on the square's grid and its colour in the
 * fourth (`paint`, 5-6-5 bits of sRGB), shaded by each face's own slope (`flatShading`), each triangle in the colour of its last corner
 * (a `flat` varying: the walls and the roof share their top corners). Made first at the opening and never let go (`massCells.ts`):
 * drawn under every cell nothing finer draws (a level not resident, let go for the budget, not come yet), so no view shows a hole in
 * the town. Its triangles run cell by cell (`BasePiece.cells`): the cells a finer level draws are left out of its draw (three's
 * geometry groups), never drawn twice. Measured on the city of 25,000 buildings (2026-10-21): 6.6 MB, 277 B a building (53 MB for 200,000).
 */

/** A run of a base's cells whose vertices fit 16-bit indices (meshoptimizer's advice: half the index memory). */
export interface BasePiece {
  /** Four unsigned shorts a vertex: its place on the base's grid (`BaseMass.place`) read normalised, and its paint (`paint`). */
  readonly vertices: Uint16Array;
  readonly index: Uint16Array | Uint32Array;
  /** Four numbers a cell of the piece that has buildings: its column, its row, its first index and its count of indices (0: none of its buildings stands from afar). In index order. */
  readonly cells: Int32Array;
  readonly bounds: Bounds;
}

/** A square's base: its pieces on one grid. */
export interface BaseMass {
  readonly pieces: readonly BasePiece[];
  readonly place: ShellGrid;
  readonly top: number;
}

/** Numbers a cell's entry holds in `BasePiece.cells`. */
export const BASE_CELL_STRIDE = 4;
/** Shorts a base vertex holds. */
export const BASE_VERTEX = 4;

/** The windows' mean over a wall from afar (`massingMaterial.ts`: the pane's share across times its height in the storey, 0.3 to 0.85, times 1.45): an ordinary wall's half-glazed bays, and a curtain wall all glass. */
const WALL_GLASS = 0.5 * 0.55 * 1.45;
const CURTAIN_GLASS = 1;
/** The glass seen from afar (`massingMaterial.ts` GLASS). */
const GLASS = rgbOf(0x7c8e98, 0.06);
/** A lot lies this far over the ground it is laid on with no floor to stand on (`massing.ts` emitLotPlates). */
const LOT_LIFT = m(0.12);
/** The smallest paved lot the base lays, m²: a yard under 10 m a side spans 2 px at the map's 0.2 px a metre, where the base is drawn; left to the finer levels, as the plates leave out a machine room (measured on the city of 25,000 buildings: three lots in four, 2.1 of its 8.7 MB). */
const LOT_AREA = m(10) * m(10);
/** The most vertices a piece holds: every index of it fits 16 bits (65535 left out: WebGL 2's primitive restart). */
const PIECE_VERTICES = 0xffff;

/** A linear channel in sRGB (IEC 61966-2-1), 0 to 1. */
const toSrgb = (c: number): number => {
  const x = Math.max(0, Math.min(1, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};
/** A linear colour as one short: 5 bits of red, 6 of green, 5 of blue, in sRGB (the dark tints keep their steps). `massingMaterial.ts` reads it back. */
export function paint(rgb: Rgb): number {
  return (Math.round(toSrgb(rgb[0]) * 31) << 11) | (Math.round(toSrgb(rgb[1]) * 63) << 5) | Math.round(toSrgb(rgb[2]) * 31);
}

/** One cell's arrays as they are written: places in floats (three's axes) and a paint a vertex. */
export class CellWriter {
  readonly position: number[] = [];
  readonly paint: number[] = [];
  readonly index: number[] = [];
  get vertices(): number { return this.paint.length; }
  /** A point of the plan at height `z`. */
  vertex(x: number, y: number, z: number, colour: number): void {
    this.position.push(x, z, -y);
    this.paint.push(colour);
  }
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A ring's signed area in the plan (positive: anticlockwise). */
function ringArea(xs: readonly number[], ys: readonly number[]): number {
  let a = 0;
  for (let i = 0, n = xs.length; i < n; i++) { const j = (i + 1) % n; a += xs[i]! * ys[j]! - xs[j]! * ys[i]!; }
  return a / 2;
}

/** A flat ring at `z` (plan points, anticlockwise), its triangles facing up; returns its first vertex. */
function slab(w: CellWriter, xs: readonly number[], ys: readonly number[], z: number, colour: number): number {
  const base = w.vertices;
  const flat: number[] = [];
  for (let i = 0; i < xs.length; i++) { w.vertex(xs[i]!, ys[i]!, z, colour); flat.push(xs[i]!, ys[i]!); }
  const tris = earcut(flat);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
    // Anticlockwise in the plan faces up (three's axes keep the plan's turn seen from above).
    const turn = (xs[b]! - xs[a]!) * (ys[c]! - ys[a]!) - (ys[b]! - ys[a]!) * (xs[c]! - xs[a]!);
    if (turn >= 0) w.index.push(base + a, base + b, base + c); else w.index.push(base + a, base + c, base + b);
  }
  return base;
}

/** A block's prism: its roof (`top`, the ring shared with the walls' heads) in its colour, its walls in theirs from their foot ring. */
function prism(w: CellWriter, xs: readonly number[], ys: readonly number[], bottom: number, top: number, wall: number, roof: number): void {
  const high = slab(w, xs, ys, top, roof);
  const n = xs.length;
  const low = w.vertices;
  for (let i = 0; i < n; i++) w.vertex(xs[i]!, ys[i]!, bottom, wall);
  // Each side seen from outside (its foot from i to j, then up: anticlockwise), each triangle's last corner on the foot: the wall's colour (WebGL 2's provoking vertex is the last).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    w.index.push(high + j, low + i, low + j, high + j, high + i, low + i);
  }
}

/** A building's blocks and paved lots into its cell's writer; `floor` as its masses' (`massFloor`), undefined with no closed block. */
export function emitBase(w: CellWriter, b: Building, floor: number | undefined, groundAt: GroundAt, signature: boolean,
  tone?: Readonly<Record<Finish, readonly [number, number, number]>>): void {
  const resolved = resolveBlocks(b);
  const f = buildingFrame(b);
  const ring = (v: Volume): { xs: number[]; ys: number[] } => {
    const xs: number[] = [], ys: number[] = [];
    for (const p of localFootprint(v)) { xs.push(frameX(f, p.x, p.y)); ys.push(frameY(f, p.x, p.y)); }
    if (ringArea(xs, ys) < 0) { xs.reverse(); ys.reverse(); }
    return { xs, ys };
  };
  // A signature building's body is drawn by its own meshes at every distance (`signature.ts`), as its masses leave it out.
  if (floor !== undefined && !signature) {
    const rgb = massColours(b, tone);
    for (const v of closedBlocks(resolved.volumes)) {
      const { xs, ys } = ring(v);
      if (xs.length < 3) continue;
      const pitched = v.roof !== 'flat' && v.roof !== 'terrace';
      const eaves = floor + volumeHeight(b, v);
      const top = eaves + (pitched ? roofRise(b, v) / 2 : 0);
      const bottom = floor + volumeElevation(b, v, v.base) - (v.base === 0 ? BURY : 0);
      const spec = wallMaterial(b, v, 0);
      const wall = mix(rgb(spec), GLASS, spec.finish === 'glass' ? CURTAIN_GLASS : WALL_GLASS);
      const roof = v.roof === 'terrace' ? TERRACE_RGB : rgb(roofMaterial(b, v));
      prism(w, xs, ys, bottom, top, paint(wall), paint(roof));
    }
  }
  // The paved lots, flat at the building's floor (or over the highest ground under them), as the masses lay them.
  const lots = resolved.volumes.filter((v) => v.open && v.open !== 'grass' && v.w * v.d >= LOT_AREA);
  if (!lots.length) return;
  let level = floor;
  if (level === undefined) {
    let ground = -Infinity;
    for (const v of resolved.volumes) if (v.open) for (const p of localFootprint(v)) ground = Math.max(ground, groundAt(frameX(f, p.x, p.y), frameY(f, p.x, p.y)));
    level = ground + LOT_LIFT;
  }
  for (const v of lots) {
    const { xs, ys } = ring(v);
    if (xs.length >= 3) slab(w, xs, ys, level, paint(rgbOf(LOT_COLOURS[v.open as keyof typeof LOT_COLOURS])));
  }
}

/** A square's base put together from its cells' writers (each building into its own cell's, `cellOf`), on the square's grid; null with no cell. */
export class BaseWriter {
  private readonly cells = new Map<string, { readonly i: number; readonly j: number; readonly w: CellWriter }>();

  /** The writer of the cell a building stands in (its position, as `layer.ts` cellOf files it). */
  cellOf(b: Building): CellWriter {
    const i = Math.floor(b.x / CELL), j = Math.floor(b.y / CELL);
    const key = `${i},${j}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = { i, j, w: new CellWriter() });
    return cell.w;
  }

  done(square: MassSquare): BaseMass | null {
    if (!this.cells.size) return null;
    const list = [...this.cells.values()].sort((p, q) => p.i - q.i || p.j - q.j);
    // The grid from the lowest point; a building reaching past its margins (rare) widens the step to hold it.
    let lowest = Infinity, top = -Infinity;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const { w } of list) {
      const p = w.position;
      for (let k = 0; k < p.length; k += 3) {
        x0 = Math.min(x0, p[k]!); x1 = Math.max(x1, p[k]!); z0 = Math.min(z0, p[k + 2]!); z1 = Math.max(z1, p[k + 2]!);
        lowest = Math.min(lowest, p[k + 1]!); top = Math.max(top, p[k + 1]!);
      }
    }
    if (!Number.isFinite(lowest)) lowest = top = 0;
    let place = massGrid(square, lowest);
    const span = place.step * 65535;
    const reach = Math.max(place.x - x0, x1 - (place.x + span), place.z - z0, z1 - (place.z + span), top - (lowest + span), 0);
    if (reach > 0) place = { x: place.x - reach - 1, y: lowest, z: place.z - reach - 1, step: (span + 2 * reach + 2) / 65535 };
    const q = (value: number, origin: number): number => Math.max(0, Math.min(65535, Math.round((value - origin) / place.step)));
    // Cells into pieces, each closed before a cell would take it past `PIECE_VERTICES` (a cell is never cut).
    const pieces: BasePiece[] = [];
    let at = 0;
    while (at < list.length) {
      let end = at, vertices = 0, indices = 0;
      do { vertices += list[end]!.w.vertices; indices += list[end]!.w.index.length; end++; }
      while (end < list.length && vertices + list[end]!.w.vertices <= PIECE_VERTICES);
      const out = new Uint16Array(vertices * BASE_VERTEX), floats = new Float32Array(vertices * 3), index = indexArray(vertices, indices);
      const cells = new Int32Array((end - at) * BASE_CELL_STRIDE);
      let v = 0, n = 0;
      for (let k = at; k < end; k++) {
        const { i, j, w } = list[k]!;
        const p = w.position;
        for (let t = 0; t < w.vertices; t++) {
          const o = (v + t) * BASE_VERTEX;
          out[o] = q(p[t * 3]!, place.x); out[o + 1] = q(p[t * 3 + 1]!, place.y); out[o + 2] = q(p[t * 3 + 2]!, place.z); out[o + 3] = w.paint[t]!;
          floats[(v + t) * 3] = p[t * 3]!; floats[(v + t) * 3 + 1] = p[t * 3 + 1]!; floats[(v + t) * 3 + 2] = p[t * 3 + 2]!;
        }
        for (let t = 0; t < w.index.length; t++) index[n + t] = w.index[t]! + v;
        cells.set([i, j, n, w.index.length], (k - at) * BASE_CELL_STRIDE);
        v += w.vertices;
        n += w.index.length;
      }
      pieces.push({ vertices: out, index, cells, bounds: vertices ? shellBounds(floats) : Float64Array.of(place.x, lowest, place.z, place.x, lowest, place.z, place.x, lowest, place.z, 0) });
      at = end;
    }
    return { pieces, place, top: Number.isFinite(top) ? top : 0 };
  }
}

/** Every buffer of a base: handed over, not copied. */
export const baseBuffers = (base: BaseMass): ArrayBuffer[] =>
  base.pieces.flatMap((piece) => [piece.vertices, piece.index, piece.cells, piece.bounds].map((a) => a.buffer as ArrayBuffer));

/** The bytes a base holds on the GPU: its vertices and indices. */
export const baseBytes = (base: BaseMass): number => base.pieces.reduce((sum, piece) => sum + piece.vertices.byteLength + piece.index.byteLength, 0);
