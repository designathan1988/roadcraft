import earcut from 'earcut';
import clipping from 'polygon-clipping';
import { Color } from 'three';
import { resolveBlocks } from '@world/buildings/blocks';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { asPolygon, edgeFrame, localFootprint, volumeSides } from '@world/buildings/footprints';
import {
  type LocalBay, bayLayout, bayWidth, closedBlocks, coveredSpans, exposedParts, localToWorld, ridgeAlongX, roofHeightAt, roofRise, roofSlope,
  sawtoothRun, shedFall, sideLength, sideStart, volumeElevation, volumeHeight,
} from '@world/buildings/geometry';
import { type Finish, type MaterialSpec, roofMaterial, trimMaterial, wallMaterial } from '@world/buildings/materials';
import { type BayComponent, type Building, type FaceId, type LotSurface, type Volume, volumeTop } from '@world/buildings/types';
import { lotSurfaces } from '@world/buildings/lots';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import { PARASOL_HALF, PARASOL_HIGH, PARASOL_LOW, ROOF_COLOURS, TANK_COLOURS, machineRooms, roofPlantOf, terraceParasols } from './roofPlan';

/** A BUILDING FROM AFAR: its blocks as they stand, one plain mesh, with the windows drawn by the shader */

export interface MassingChunk {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  /** Per vertex: metres along its face, the face's bay width */
  readonly facade: Float32Array;
  /** Per vertex: the share of a bay its windows take across (1: a curtain wall), and the building's seed */
  readonly glazing: Float32Array;
  readonly index: Uint32Array;
  /** The tallest thing this level left out or laid flat, m (`MassDetail`): 0 at the cell's level. */
  readonly error: number;
}

/** WHAT A LEVEL OF THE MASSES LEAVES OUT: the cell's (all of it), a tile's (L2) and a plate's (L3, `massLevels.ts`) */
export interface MassDetail {
  /** The tallest thing left out or laid flat, m: a relief and its cheeks, a parapet, a box on the roof, a machine room. */
  readonly drop: number;
  /** Each block a box: its pitched roof under `drop` laid flat at its eaves (L3). */
  readonly boxes: boolean;
}
export const CELL_DETAIL: MassDetail = { drop: 0, boxes: false };
/** A tile's: under 3 m (a machine room, `MACHINE_ROOM_H`; a parapet; an arcade's set-back, `ARCADE`). */
export const TILE_DETAIL: MassDetail = { drop: m(3), boxes: false };
/** A plate's: under 8 m, the pitched roofs of houses and low blocks flattened too. */
export const PLATE_DETAIL: MassDetail = { drop: m(8), boxes: true };

/** Where the wall of a block on the ground starts: below the lowest ground under it, as the detailed plinth does. */
export const BURY = m(1.5);
/** The parapet round a flat roof, and the attic band of the 'attic' dress (`buildingMesh.ts`). */
const PARAPET_H = m(0.85);
const ATTIC_H = m(1.5);
const PARAPET_T = m(0.25);
/** A pitched roof's overhang at the eaves (`buildingMesh.ts` EAVES). */
const EAVES = m(0.45);
/** A machine room over a lift core. */
const MACHINE_ROOM_H = m(3);

const TERRACE_RGB = rgbOf(0xb0a595);
const SAW_GLASS_RGB = rgbOf(0x3c5360);

export function rgbOf(hex: number, shade = 1): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
}

type Rgb = readonly [number, number, number];
/** A facade's pattern at a vertex: along, bay, storey height, first storey's height; and the glass share. */
interface Facade { readonly bay: number; readonly storey: number; readonly z0: number; readonly share: number }
const NO_FACADE: Facade = { bay: 0, storey: 1, z0: 0, share: 0 };

/** A typed array written at its end, its room doubled as it fills: DO NOT gather numbers in a `number[]` (8 bytes each and its copies as it grows) for a typed array made at the end. */
class Grown<T extends Float32Array | Uint32Array> {
  length = 0;
  constructor(private array: T, private readonly make: (n: number) => T) {}
  private room(n: number): T {
    if (this.length + n > this.array.length) {
      const bigger = this.make(Math.max(this.array.length * 2, this.length + n));
      bigger.set(this.array.subarray(0, this.length) as never);
      this.array = bigger;
    }
    return this.array;
  }
  push2(a: number, b: number): void { const t = this.room(2); t[this.length++] = a; t[this.length++] = b; }
  push3(a: number, b: number, c: number): void { const t = this.room(3); t[this.length++] = a; t[this.length++] = b; t[this.length++] = c; }
  push4(a: number, b: number, c: number, d: number): void { const t = this.room(4); t[this.length++] = a; t[this.length++] = b; t[this.length++] = c; t[this.length++] = d; }
  /** What was written, in an array of its own size. */
  done(): T {
    return this.array.slice(0, this.length) as T;
  }
}
const floats = (n: number): Float32Array => new Float32Array(n);
const uints = (n: number): Uint32Array => new Uint32Array(n);

class MassWriter {
  readonly position = new Grown(floats(96), floats);
  readonly normal = new Grown(floats(96), floats);
  readonly colour = new Grown(floats(96), floats);
  readonly facade = new Grown(floats(128), floats);
  readonly glazing = new Grown(floats(64), floats);
  readonly index = new Grown(uints(96), uints);
  /** The tallest thing left out so far (`leaves`). */
  error = 0;

  constructor(private readonly b: Building, private readonly seed: number, readonly detail: MassDetail = CELL_DETAIL) {}

  /** Whether a thing `size` m tall or deep is left out at this level; its size kept as the level's error when it is. */
  leaves(size: number): boolean {
    if (!(size > 0) || size > this.detail.drop) return false;
    this.error = Math.max(this.error, size);
    return true;
  }

  /** A point of the building's plan at height z, in three's axes. */
  P(lx: number, ly: number, z: number): [number, number, number] {
    const w = localToWorld(this.b, lx, ly);
    return [w.x, z, -w.y];
  }

  /** A plan direction (local) and up, as a three normal. */
  N(lx: number, ly: number, up = 0): [number, number, number] {
    const c = Math.cos(this.b.rotation), s = Math.sin(this.b.rotation);
    const wx = lx * c - ly * s, wy = lx * s + ly * c;
    const l = Math.hypot(wx, wy, up) || 1;
    return [wx / l, up / l, -wy / l];
  }

  /** A convex polygon of points (three's axes), all with one normal and colour; `along` its points' metres along their face */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], rgb: Rgb, f: Facade = NO_FACADE, along?: readonly number[]): void {
    const base = this.position.length / 3;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      this.position.push3(p[0], p[1], p[2]);
      this.normal.push3(n[0], n[1], n[2]);
      this.colour.push3(rgb[0], rgb[1], rgb[2]);
      this.facade.push4(along?.[i] ?? 0, f.bay, f.storey, f.z0);
      this.glazing.push2(f.share, this.seed);
    }
    // Wound to face its normal (three's axes mirror the plan's y).
    const a = points[0]!, b = points[1]!, c = points[2]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const forward = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] >= 0;
    for (let i = 1; i + 1 < points.length; i++) {
      if (forward) this.index.push3(base, base + i, base + i + 1);
      else this.index.push3(base, base + i + 1, base + i);
    }
  }

  chunk(): MassingChunk {
    return {
      position: this.position.done(),
      normal: this.normal.done(),
      colour: this.colour.done(),
      facade: this.facade.done(),
      glazing: this.glazing.done(),
      index: this.index.done(),
      error: this.error,
    };
  }
}

/** The building's own shade, as the detailed one has it (`buildingMesh.ts` `emitBuilding`). */
const shadeOf = (b: Building): number => 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;

/** A building's floor as the detailed one's (`buildingMesh.ts` `emitChunk`, `floorHeight`); undefined with no closed block. */
export function massFloor(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  const resolved = resolveBlocks(b);
  return closedBlocks(resolved.volumes).length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** A building's mass from afar, on the ground it stands on (the floor worked out as the detailed building's, `floorHeight`) */
export function emitMassing(
  b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, signature = false,
  /** Each finish's colour from afar (`finishes.ts` `finishAlbedo`): the detailed walls' tint times their texture's mean; none, the bare tint. */
  tone?: Readonly<Record<Finish, readonly [number, number, number]>>,
  /** What the level leaves out (a tile's, a plate's); the cell's keeps all. */
  detail: MassDetail = CELL_DETAIL,
  /** Its floor already worked out (`massFloor`): a tile's bake reads it once for its two levels and its boxes. */
  known?: { readonly floor: number | undefined },
): MassingChunk | null {
  const resolved = resolveBlocks(b);
  // One list for the blocks (`closedBlocks`, as `buildingMesh.ts` `emitChunk`): every block of the body reads one layout of its bays (`bayLayout`).
  const closed = closedBlocks(resolved.volumes);
  const office = b.use === 'commercial' || b.use === 'industrial' ? 2 : 0;
  const w = new MassWriter(b, ((b.id * 2654435761) >>> 0) / 4294967296 + office, detail);
  // The floor as the detailed building's (`buildingMesh.ts` `emitChunk`)
  const floor = known ? known.floor : massFloor(b, naturalAt, pavedAt);
  if (floor !== undefined && !signature) {
    const shade = shadeOf(b);
    const rgb = (spec: MaterialSpec): Rgb => {
      const c = rgbOf(spec.colour, shade), t = tone?.[spec.finish];
      return t ? [c[0] * t[0], c[1] * t[1], c[2] * t[2]] : c;
    };
    // The body as the detailed building draws it: its closed blocks alone (`buildingMesh.ts` `emitChunk`).
    const body = { ...resolved, volumes: closed };
    for (const v of closed) emitVolume(w, body, v, floor, rgb);
    emitMachineRooms(w, body, floor, rgb);
  }
  emitLotPlates(w, resolved, floor, groundAt, pavedAt);
  return w.position.length ? w.chunk() : null;
}

/** Numbers per far box (`emitBoxes`): centre x, y; half sides along the building's x and y; its turn; the wall's foot, the top, the floor; the wall's and the roof's colour; bay, storey, glass share, seed; the block's plan area. */
export const BOX_FLOATS = 19;

/** A BUILDING AS BOXES, for the levels past the plates (`farTiles.ts`): each closed block the box of its plan, its roof's rise halved, coloured and glazed as its mass */
export function emitBoxes(
  b: Building, pavedAt: PavedAt | undefined, naturalAt: GroundAt, tone: Readonly<Record<Finish, readonly [number, number, number]>> | undefined, out: number[],
  known?: { readonly floor: number | undefined },
): void {
  const resolved = resolveBlocks(b);
  const closed = closedBlocks(resolved.volumes);
  if (closed.length === 0) return;
  // The floor as the mass's (`emitMassing`).
  const floor = known?.floor ?? floorHeight(resolved, naturalAt, pavedAt);
  const shade = shadeOf(b);
  const rgb = (spec: MaterialSpec): Rgb => {
    const c = rgbOf(spec.colour, shade), t = tone?.[spec.finish];
    return t ? [c[0] * t[0], c[1] * t[1], c[2] * t[2]] : c;
  };
  const office = b.use === 'commercial' || b.use === 'industrial' ? 2 : 0;
  const seed = ((b.id * 2654435761) >>> 0) / 4294967296 + office;
  const body = { ...resolved, volumes: closed };
  // The glass share of each block: its bays' mean (`GLASS_SHARE`), as the mass's walls have it.
  const glass = new Map<number, { sum: number; n: number }>();
  for (const bay of bayLayout(body)) {
    const g = glass.get(bay.volume) ?? { sum: 0, n: 0 };
    g.sum += GLASS_SHARE[bay.component] ?? 0;
    g.n++;
    glass.set(bay.volume, g);
  }
  for (const v of closed) {
    const ring = localFootprint(v);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      twice += p.x * q.y - q.x * p.y;
    }
    const centre = localToWorld(body, (x0 + x1) / 2, (y0 + y1) / 2);
    const base = floor + volumeElevation(body, v, v.base);
    const eaves = floor + volumeHeight(body, v);
    const pitched = v.roof !== 'flat' && v.roof !== 'terrace';
    const wall = rgb(wallMaterial(body, v, 0));
    const roof = v.roof === 'terrace' ? TERRACE_RGB : rgb(roofMaterial(body, v));
    const g = glass.get(v.id);
    const share = wallMaterial(body, v, 0).finish === 'glass' ? 1 : g && g.n > 0 ? g.sum / g.n : 0;
    out.push(
      centre.x, centre.y, (x1 - x0) / 2, (y1 - y0) / 2, b.rotation,
      v.base === 0 ? base - BURY : base, eaves + (pitched ? roofRise(body, v) / 2 : 0), base,
      wall[0], wall[1], wall[2], roof[0], roof[1], roof[2],
      bayWidth(body, v, 0), b.storeyHeight, share, seed, Math.abs(twice) / 2,
    );
  }
}

/** The colours of a lot's surface (`buildingMesh.ts` draws them in their finishes) */
export const LOT_COLOURS: Readonly<Record<LotSurface, number>> = {
  grass: 0x6f9a4c, paving: 0xc4beb2, gravel: 0xa9a294, sand: 0xe2cf9c, water: 0x4f8fb3,
  asphalt: 0x515457, concrete: 0xb9b6ae, pavers: 0x9a958c, tiles: 0xb4785a,
};

/** The paved lots - car parks, yards, courts - as the detailed lots lay them */
function emitLotPlates(w: MassWriter, b: Building, buildingFloor: number | undefined, groundAt: GroundAt, pavedAt?: PavedAt): void {
  const lots = b.volumes.filter((v) => v.open && v.open !== 'grass');
  if (lots.length === 0) return;
  let ground = -Infinity;
  for (const v of b.volumes) {
    if (!v.open) continue;
    for (const p of localFootprint(v)) { const q = localToWorld(b, p.x, p.y); ground = Math.max(ground, groundAt(q.x, q.y)); }
    const c = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
    ground = Math.max(ground, groundAt(c.x, c.y));
  }
  const level = buildingFloor ?? ground + m(0.12);
  const up = w.N(0, 0, 1);
  for (const surface of lotSurfaces(b, level, pavedAt)) {
    const v = surface.volume;
    if (!v.open || v.open === 'grass') continue;
    const colour = rgbOf(LOT_COLOURS[v.open]);
    const ring = localFootprint(v);
    const flatRing = ring.flatMap((p) => [p.x, p.y]);
    const tris = earcut(flatRing);
    const point = (k: number): [number, number, number] => {
      const q = localToWorld(b, flatRing[2 * k]!, flatRing[2 * k + 1]!);
      return [q.x, surface.heightAt(q.x, q.y), -q.y];
    };
    for (let i = 0; i < tris.length; i += 3) w.face([point(tris[i]!), point(tris[i + 1]!), point(tris[i + 2]!)], up, colour);
  }
}

/** The share of a bay its window takes across, by what the bay holds (a curtain wall is all glass). */
export const GLASS_SHARE: Partial<Record<BayComponent, number>> = {
  window: 0.5, sashWindow: 0.5, shutteredWindow: 0.5, brise: 0.5,
  wideWindow: 0.75, ribbon: 0.8, bayWindow: 0.75,
  frenchWindow: 0.6, balcony: 0.6, gourmet: 0.7, loggia: 0.7,
  door: 0.35, doubleDoor: 0.5, shopfront: 0.85, pillar: 0.7,
};
/** How far an arcade's wall steps back behind its columns (`buildingMesh.ts` ARCADE). */
const ARCADE = m(1.8);

/** A block's walls from its bays as the detailed building lays them (`facadeBays`), off the layout every block of the body reads (`bayLayout`, worked out once) */
function emitVolume(w: MassWriter, b: Building, v: Volume, floor: number, rgb: (spec: MaterialSpec) => Rgb): void {
  const eaves = floor + volumeHeight(b, v);
  // Each storey of each side, by a number (no text a bay): a side's index is under 4096.
  const rows = new Map<number, LocalBay[]>();
  for (const bay of bayLayout(b)) {
    if (bay.volume !== v.id) continue;
    const key = bay.level * 4096 + bay.side;
    const list = rows.get(key);
    if (list) list.push(bay); else rows.set(key, [bay]);
  }
  /** One run of a storey (bays side by side with the same relief and glass), before the storeys alike are stacked into one. */
  interface Run { side: number; a0: number; a1: number; d: number; z0: number; z1: number; zb: number; height: number; glass: number; colour: Rgb }
  const runs: Run[] = [];
  for (const row of rows.values()) {
    row.sort((p, q) => p.start - q.start);
    const side = row[0]!.side;
    // The run's outward offset: a relief's push, an arcade's wall set back.
    // Laid flat where the level leaves it out: the wall then runs on with its neighbours (one quad where they were coplanar).
    const offsetOf = (bay: LocalBay): number => {
      const d = bay.component === 'pillar' ? -ARCADE : bay.push;
      return w.leaves(Math.abs(d)) ? 0 : d;
    };
    const shareOf = (bay: LocalBay): number => GLASS_SHARE[bay.component] ?? 0;
    let i = 0;
    while (i < row.length) {
      const first = row[i]!;
      let j = i + 1;
      while (j < row.length && Math.abs(offsetOf(row[j]!) - offsetOf(first)) < 1e-3 && shareOf(row[j]!) === shareOf(first)
        && Math.abs(row[j]!.start - (row[j - 1]!.start + row[j - 1]!.width)) < 1e-3) j++;
      const last = row[j - 1]!;
      const z0 = floor + first.z;
      const spec = wallMaterial(b, v, side, first.storey);
      runs.push({
        side, a0: first.start, a1: last.start + last.width, d: offsetOf(first), z0, z1: z0 + first.height,
        // A storey on the ground runs down past the lowest ground under it, as the plinth does.
        zb: v.base === 0 && first.storey === 0 ? z0 - BURY : z0,
        height: first.height, glass: spec.finish === 'glass' ? 1 : shareOf(first), colour: rgb(spec),
      });
      i = j;
    }
  }
  // DO NOT draw a quad a storey: the storeys alike, one above the other, are one wall whose windows the shader counts up from the lowest (`massingMaterial.ts`, `(height - z0) / storey`).
  const alike = (p: Run, q: Run): boolean => p.side === q.side && Math.abs(p.a0 - q.a0) < 1e-3 && Math.abs(p.a1 - q.a1) < 1e-3 && Math.abs(p.d - q.d) < 1e-3
    && Math.abs(p.height - q.height) < 1e-3 && p.glass === q.glass && p.colour[0] === q.colour[0] && p.colour[1] === q.colour[1] && p.colour[2] === q.colour[2];
  runs.sort((p, q) => p.side - q.side || p.a0 - q.a0 || p.d - q.d || p.z0 - q.z0);
  for (let i = 0; i < runs.length;) {
    const first = runs[i]!;
    let z1 = first.z1, j = i + 1;
    while (j < runs.length && alike(runs[j]!, first) && Math.abs(runs[j]!.z0 - z1) < 1e-3) z1 = runs[j++]!.z1;
    i = j;
    const { side, a0, a1, d, z0, zb, colour } = first;
    const f = edgeFrame(v, side), s = sideStart(v, side);
    const t = { x: s.tx, y: s.ty };
    const at = (a: number, out: number, z: number): [number, number, number] => w.P(s.x + t.x * a + f.nx * out, s.y + t.y * a + f.ny * out, z);
    const facade = { bay: bayWidth(b, v, side), storey: first.height, z0, share: first.glass };
    w.face([at(a0, d, zb), at(a1, d, zb), at(a1, d, z1), at(a0, d, z1)], w.N(f.nx, f.ny), colour, facade, [a0, a1, a1, a0]);
    if (Math.abs(d) > 1e-3) {
      // Its cheeks at both ends and its head: a box standing out, or a recess.
      const sign = d > 0 ? 1 : -1;
      w.face([at(a0, 0, zb), at(a0, d, zb), at(a0, d, z1), at(a0, 0, z1)], w.N(-t.x * sign, -t.y * sign), colour);
      w.face([at(a1, d, zb), at(a1, 0, zb), at(a1, 0, z1), at(a1, d, z1)], w.N(t.x * sign, t.y * sign), colour);
      w.face([at(a0, 0, z1), at(a1, 0, z1), at(a1, d, z1), at(a0, d, z1)], w.N(0, 0, sign), colour);
    }
  }
  const flat = v.roof === 'flat';
  const crown = flat ? (v.dress?.crown === 'attic' ? ATTIC_H : PARAPET_H) : 0;
  if (crown > 0 && !w.leaves(crown)) {
    // The parapet only where the roof really ends: not against a neighbour as tall or taller (`buildingMesh.ts` `emitRoof`).
    const top = volumeTop(v);
    for (const side of volumeSides(v)) {
      const f = edgeFrame(v, side), s = sideStart(v, side);
      const spans = [...coveredSpans(b, v, side, top - 1), ...coveredSpans(b, v, side, top)].sort((p, q) => p[0] - q[0]);
      const spec = wallMaterial(b, v, side);
      const wall = rgb({ ...spec, finish: spec.finish === 'glass' ? 'concrete' : spec.finish });
      // Inside, the roof's membrane carried up the parapet, as the detailed building has it (`buildingMesh.ts` `emitRoof`).
      const roofTint = rgb(roofMaterial(b, v));
      const inner: Rgb = [roofTint[0] * 0.9, roofTint[1] * 0.9, roofTint[2] * 0.9];
      const at = (a: number, depth: number, z: number): [number, number, number] => w.P(s.x + s.tx * a - f.nx * depth, s.y + s.ty * a - f.ny * depth, z);
      for (const [p0, p1] of exposedParts(spans, 0, sideLength(v, side))) {
        w.face([at(p0, 0, eaves), at(p1, 0, eaves), at(p1, 0, eaves + crown), at(p0, 0, eaves + crown)], w.N(f.nx, f.ny), wall);
        w.face([at(p0, 0, eaves + crown), at(p1, 0, eaves + crown), at(p1, PARAPET_T, eaves + crown), at(p0, PARAPET_T, eaves + crown)], w.N(0, 0, 1), wall);
        w.face([at(p1, PARAPET_T, eaves), at(p0, PARAPET_T, eaves), at(p0, PARAPET_T, eaves + crown), at(p1, PARAPET_T, eaves + crown)], w.N(-f.nx, -f.ny), inner);
      }
    }
  }
  emitRoof(w, b, v, floor, eaves, rgb);
}

function emitRoof(w: MassWriter, b: Building, v: Volume, floor: number, eaves: number, rgb: (spec: MaterialSpec) => Rgb): void {
  const roof = v.roof === 'terrace' ? TERRACE_RGB : rgb(roofMaterial(b, v));
  const up = w.N(0, 0, 1);
  // A plate's box: a pitched roof whose rise the level leaves out, laid flat at its eaves (its gables gone with it).
  const flatten = v.roof !== 'flat' && v.roof !== 'terrace' && w.detail.boxes && w.leaves(roofRise(b, v));
  if (v.roof === 'flat' || v.roof === 'terrace' || flatten) {
    // The slab at the roof's own level (its parapet is the walls'), and what stands on it - as the detailed roof has them.
    const ring = localFootprint(v);
    const flatRing = ring.flatMap((p) => [p.x, p.y]);
    const tris = earcut(flatRing);
    for (let i = 0; i < tris.length; i += 3) {
      w.face([0, 1, 2].map((k) => w.P(flatRing[2 * tris[i + k]!]!, flatRing[2 * tris[i + k]! + 1]!, eaves)), up, roof);
    }
    if (flatten) return;
    const built = b.volumes.some((o) => o !== v && !o.open && o.base === volumeTop(v));
    if (v.roof === 'flat') emitRoofPlant(w, b, v, eaves, rgb);
    else if (!built) {
      const parasols = terraceParasols(b, v);
      const parasol = rgbOf(ROOF_COLOURS.parasol);
      if (parasols.length && !w.leaves(PARASOL_HIGH)) for (const p of parasols) box(w, p.x - PARASOL_HALF, p.y - PARASOL_HALF, p.x + PARASOL_HALF, p.y + PARASOL_HALF, eaves + PARASOL_LOW, eaves + PARASOL_HIGH, parasol, parasol);
    }
    return;
  }
  if (v.outline) { emitPolygonRoof(w, b, v, eaves, roof, rgb); return; }
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const slope = roofSlope(v);
  const wallOf = (side: FaceId): Rgb => rgb(wallMaterial(b, v, side));
  if (v.roof === 'gable' || v.roof === 'hip') {
    const alongX = ridgeAlongX(v);
    const eave = eaves - EAVES * slope;
    const ridge = eaves + roofRise(b, v);
    const span = alongX ? y1 - y0 : x1 - x0;
    const hip = v.roof === 'hip' ? Math.min(span / 2, (alongX ? x1 - x0 : y1 - y0) / 2) : 0;
    const L = (along: number, across: number, z: number): [number, number, number] => (alongX ? w.P(along, across, z) : w.P(across, along, z));
    const a0 = alongX ? x0 : y0, a1 = alongX ? x1 : y1, c0 = alongX ? y0 : x0, c1 = alongX ? y1 : x1, cm = (c0 + c1) / 2;
    const o = EAVES, r0 = a0 + hip, r1 = a1 - hip;
    w.face([L(a0 - o, c0 - o, eave), L(a1 + o, c0 - o, eave), L(r1, cm, ridge), L(r0, cm, ridge)], alongX ? w.N(0, -slope, 1) : w.N(-slope, 0, 1), roof);
    w.face([L(a1 + o, c1 + o, eave), L(a0 - o, c1 + o, eave), L(r0, cm, ridge), L(r1, cm, ridge)], alongX ? w.N(0, slope, 1) : w.N(slope, 0, 1), roof);
    if (v.roof === 'hip') {
      w.face([L(a0 - o, c1 + o, eave), L(a0 - o, c0 - o, eave), L(r0, cm, ridge)], alongX ? w.N(-slope, 0, 1) : w.N(0, -slope, 1), roof);
      w.face([L(a1 + o, c0 - o, eave), L(a1 + o, c1 + o, eave), L(r1, cm, ridge)], alongX ? w.N(slope, 0, 1) : w.N(0, slope, 1), roof);
    } else {
      w.face([L(a0, c0, eaves), L(a0, c1, eaves), L(a0, cm, ridge)], alongX ? w.N(-1, 0) : w.N(0, -1), wallOf(alongX ? 3 : 0));
      w.face([L(a1, c1, eaves), L(a1, c0, eaves), L(a1, cm, ridge)], alongX ? w.N(1, 0) : w.N(0, 1), wallOf(alongX ? 1 : 2));
    }
    return;
  }
  if (v.roof === 'shed') {
    const fall = shedFall(v);
    const lowAlongX = fall === 0 || fall === 2;
    const eaveLength = lowAlongX ? x1 - x0 : y1 - y0, run = lowAlongX ? y1 - y0 : x1 - x0;
    const Q = (a: number, t: number, z: number): [number, number, number] => {
      switch (fall) {
        case 0: return w.P(x0 + a * (x1 - x0), y0 + t * (y1 - y0), z);
        case 2: return w.P(x0 + a * (x1 - x0), y1 - t * (y1 - y0), z);
        case 3: return w.P(x0 + t * (x1 - x0), y0 + a * (y1 - y0), z);
        default: return w.P(x1 - t * (x1 - x0), y0 + a * (y1 - y0), z);
      }
    };
    const high = eaves + run * slope;
    const oa = EAVES / eaveLength, ot = EAVES / run;
    const nf = fall === 0 ? [0, -1] : fall === 2 ? [0, 1] : fall === 3 ? [-1, 0] : [1, 0];
    w.face([Q(-oa, -ot, eaves - EAVES * slope), Q(1 + oa, -ot, eaves - EAVES * slope), Q(1 + oa, 1 + ot, high + EAVES * slope), Q(-oa, 1 + ot, high + EAVES * slope)],
      w.N(nf[0]! * slope, nf[1]! * slope, 1), roof);
    const back = ((fall + 2) % 4) as FaceId;
    for (const end of [0, 1, 2, 3].filter((s) => s !== fall && s !== back) as FaceId[]) {
      const a = (lowAlongX ? end === 3 : end === 0) ? 0 : 1;
      const ne = end === 0 ? [0, -1] : end === 2 ? [0, 1] : end === 3 ? [-1, 0] : [1, 0];
      w.face([Q(a, 0, eaves), Q(a, 1, eaves), Q(a, 1, high)], w.N(ne[0]!, ne[1]!), wallOf(end));
    }
    const nb = back === 0 ? [0, -1] : back === 2 ? [0, 1] : back === 3 ? [-1, 0] : [1, 0];
    w.face([Q(0, 1, eaves), Q(1, 1, eaves), Q(1, 1, high), Q(0, 1, high)], w.N(nb[0]!, nb[1]!), wallOf(back));
    return;
  }
  // Sawtooth: its teeth, the steep face glazed.
  const tooth = sawtoothRun(b, v);
  const toothRise = tooth * 0.5 * slope;
  for (let t0 = y0; t0 < y1 - 1e-6; t0 += tooth) {
    const t1 = Math.min(y1, t0 + tooth);
    const h = toothRise * ((t1 - t0) / tooth);
    w.face([w.P(x0, t0, eaves), w.P(x1, t0, eaves), w.P(x1, t1, eaves + h), w.P(x0, t1, eaves + h)], w.N(0, -1, 2), roof);
    w.face([w.P(x1, t1, eaves), w.P(x0, t1, eaves), w.P(x0, t1, eaves + h), w.P(x1, t1, eaves + h)], w.N(0, 1), SAW_GLASS_RGB);
    w.face([w.P(x0, t0, eaves), w.P(x0, t1, eaves), w.P(x0, t1, eaves + h)], w.N(-1, 0), wallOf(3));
    w.face([w.P(x1, t1, eaves), w.P(x1, t0, eaves), w.P(x1, t1, eaves + h)], w.N(1, 0), wallOf(1));
  }
  void floor;
}

/** A pitched roof over a shaped block: the roof's surface */
function emitPolygonRoof(w: MassWriter, b: Building, v: Volume, eaves: number, roof: Rgb, rgb: (spec: MaterialSpec) => Rgb): void {
  const ring = localFootprint(v);
  const height = (p: Vec2): number => eaves + roofHeightAt(b, v, p);
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const rect = (a: number, c: number, d: number, f: number): Vec2[] => [{ x: a, y: c }, { x: d, y: c }, { x: d, y: f }, { x: a, y: f }];
  // The planes the roof is made of, as `buildingMesh.ts` `emitPolygonRoof` cuts them.
  let patches: Vec2[][];
  if (v.roof === 'gable') {
    patches = ridgeAlongX(v)
      ? [rect(x0, y0, x1, (y0 + y1) / 2), rect(x0, (y0 + y1) / 2, x1, y1)]
      : [rect(x0, y0, (x0 + x1) / 2, y1), rect((x0 + x1) / 2, y0, x1, y1)];
  } else if (v.roof === 'hip') {
    const alongX = v.w >= v.d, long = alongX ? v.w : v.d, short = alongX ? v.d : v.w, h = short / 2;
    const P = (u: number, a: number): Vec2 => (alongX ? { x: x0 + u, y: y0 + a } : { x: x0 + a, y: y0 + u });
    patches = [[P(0, 0), P(h, h), P(0, short)], [P(long, 0), P(long, short), P(long - h, h)],
      [P(0, 0), P(long, 0), P(long - h, h), P(h, h)], [P(h, h), P(long - h, h), P(long, short), P(0, short)]];
  } else if (v.roof === 'shed') {
    patches = [rect(x0, y0, x1, y1)];
  } else {
    patches = [];
    const run = sawtoothRun(b, v);
    for (let from = y0; from < y1 - 1e-6; from += run) {
      const to = Math.min(y1, from + run), mid = (from + to) / 2;
      patches.push(rect(x0, from, x1, mid), rect(x0, mid, x1, to));
    }
  }
  const footprint = asPolygon(ring);
  for (const patch of patches) {
    for (const piece of clipping.intersection(footprint, asPolygon(patch))) {
      const outer = piece[0];
      if (!outer || outer.length < 4) continue;
      const pts = outer.slice(0, -1).map(([x, y]) => ({ x: x!, y: y! }));
      const flatRing = pts.flatMap((p) => [p.x, p.y]);
      const tris = earcut(flatRing);
      // The plane's normal from three of its points.
      const a = pts[0]!, c = pts[Math.floor(pts.length / 2)]!, d = pts[pts.length - 1]!;
      const pa = w.P(a.x, a.y, height(a)), pc = w.P(c.x, c.y, height(c)), pd = w.P(d.x, d.y, height(d));
      const ux = pc[0] - pa[0], uy = pc[1] - pa[1], uz = pc[2] - pa[2], vx = pd[0] - pa[0], vy = pd[1] - pa[1], vz = pd[2] - pa[2];
      let n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
      for (let i = 0; i < tris.length; i += 3) {
        w.face([0, 1, 2].map((k) => { const p = pts[tris[i + k]!]!; return w.P(p.x, p.y, height(p)); }), n, roof);
      }
    }
  }
  // Each wall filled up to the roof over it (a gable where the ridge meets it).
  const sides = volumeSides(v);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-6) continue;
    const steps = 8;
    const nx = (q.y - p.y) / len, ny = -(q.x - p.x) / len;
    const colour = rgb(wallMaterial(b, v, (sides[i] ?? 0) as FaceId));
    for (let k = 0; k < steps; k++) {
      const s0 = { x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps };
      const s1 = { x: p.x + ((q.x - p.x) * (k + 1)) / steps, y: p.y + ((q.y - p.y) * (k + 1)) / steps };
      const h0 = height(s0), h1 = height(s1);
      if (h0 - eaves < 1e-3 && h1 - eaves < 1e-3) continue;
      w.face([w.P(s0.x, s0.y, eaves), w.P(s1.x, s1.y, eaves), w.P(s1.x, s1.y, h1), w.P(s0.x, s0.y, h0)], w.N(nx, ny), colour);
    }
  }
}

/** A box of the plan from z0 to z1: its four sides and its top. */
function box(w: MassWriter, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, sides: Rgb, top: Rgb): void {
  w.face([w.P(x0, y0, z0), w.P(x1, y0, z0), w.P(x1, y0, z1), w.P(x0, y0, z1)], w.N(0, -1), sides);
  w.face([w.P(x1, y1, z0), w.P(x0, y1, z0), w.P(x0, y1, z1), w.P(x1, y1, z1)], w.N(0, 1), sides);
  w.face([w.P(x1, y0, z0), w.P(x1, y1, z0), w.P(x1, y1, z1), w.P(x1, y0, z1)], w.N(1, 0), sides);
  w.face([w.P(x0, y1, z0), w.P(x0, y0, z0), w.P(x0, y0, z1), w.P(x0, y1, z1)], w.N(-1, 0), sides);
  w.face([w.P(x0, y0, z1), w.P(x1, y0, z1), w.P(x1, y1, z1), w.P(x0, y1, z1)], w.N(0, 0, 1), top);
}

/** The roof plant drawn from afar (`emitRoofPlant`): the rest is under a metre across. */
const DRAWN_PLANT: ReadonlySet<string> = new Set(['liftRoom', 'tankBox', 'airHandler', 'skylight', 'solar', 'tank', 'chimney']);

/** The plant on a flat roof a metre or more across (`roofPlan.ts`, the plan the detailed roof draws) */
function emitRoofPlant(w: MassWriter, b: Building, v: Volume, z: number, rgb: (spec: MaterialSpec) => Rgb): void {
  const plant = rgbOf(ROOF_COLOURS.plant);
  const trimSpec = trimMaterial(b);
  // The trim as the detailed building has it: metal frames' mouldings are the skin a shade lighter.
  const trim = trimSpec.finish === 'metal' && b.materials?.wall ? rgbOf(b.materials.wall.colour, shadeOf(b) * 1.1) : rgb(trimSpec);
  for (const it of roofPlantOf(b, v)) {
    // Left out where the level leaves a thing that tall (a panel's 0.32 m, a tank's or a lift room's height); the kinds never drawn here count for nothing.
    if (DRAWN_PLANT.has(it.kind) && w.leaves(it.kind === 'solar' ? m(0.32) : it.h)) continue;
    const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2, half = Math.min(it.x1 - it.x0, it.y1 - it.y0) / 2;
    switch (it.kind) {
      case 'liftRoom': case 'tankBox': box(w, it.x0, it.y0, it.x1, it.y1, z, z + it.h, trim, plant); break;
      case 'airHandler': { const c = rgbOf(ROOF_COLOURS.condenser); box(w, it.x0, it.y0, it.x1, it.y1, z + m(0.2), z + it.h, c, c); break; }
      case 'skylight': box(w, it.x0, it.y0, it.x1, it.y1, z, z + it.h, plant, rgbOf(ROOF_COLOURS.skylight)); break;
      case 'solar': { const c = rgbOf(ROOF_COLOURS.solar); box(w, it.x0, it.y0, it.x1, it.y1, z + m(0.25), z + m(0.32), c, c); break; }
      case 'tank': {
        // A round tank as the square of its area (r * 0.84, `buildingMesh.ts`).
        const r = half * 0.84 * Math.sqrt(Math.PI) / 2;
        const c = rgbOf(TANK_COLOURS[it.variant % TANK_COLOURS.length]!);
        box(w, cx - r, cy - r, cx + r, cy + r, z, z + it.h, c, c);
        break;
      }
      case 'chimney': { const r = half * 0.9 * Math.sqrt(Math.PI) / 2, c = rgbOf(ROOF_COLOURS.chimney); box(w, cx - r, cy - r, cx + r, cy + r, z, z + it.h, c, c); break; }
      default: break;
    }
  }
}

/** The machine rooms over the lift cores, on the highest flat roof over each (`buildingMesh.ts`). */
function emitMachineRooms(w: MassWriter, b: Building, floor: number, rgb: (spec: MaterialSpec) => Rgb): void {
  const trim = rgb(trimMaterial(b));
  for (const { volume: best, x0, y0, x1, y1 } of machineRooms(b)) {
    if (w.leaves(MACHINE_ROOM_H)) continue;
    const z = floor + volumeHeight(b, best);
    const skin = best.dress ? rgb(wallMaterial(b, best, 0)) : trim;
    box(w, x0, y0, x1, y1, z, z + MACHINE_ROOM_H, skin, rgbOf(ROOF_COLOURS.plant));
  }
}
