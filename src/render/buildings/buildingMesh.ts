import { identityMemo } from '@core/identityMemo';
import earcut from 'earcut';
import clipping from 'polygon-clipping';
import { resolveBlocks } from '@world/buildings/blocks';
import { type LotSurface as LotPlane, lotSurfaces } from '@world/buildings/lots';
import { POOL_SINK } from '@world/buildings/pads';
import { deriveSpaces } from '@world/buildings/spaces';
import { spaceSeed } from './lightSlots';
import { localToWorld, worldToLocal } from '@world/buildings/geometry';
import { FURNITURE_KINDS, FURNITURE_SIZE, type Furniture, type FurnitureKind, interiorAt, levelFlights } from '@world/buildings/interior';
import { ROOM_FLOATS, floorKind, roomsOfStorey } from './roomBehind';
import { asPolygon, edgeFrame, localFootprint, volumeSides } from '@world/buildings/footprints';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  Sphere,
  Vector3,
  Box3,
} from 'three';
import {
  type Bounds, COLOURED_PARTS, type CellArrays, type CellSelection, FACADE_BYTES, FACADE_FLOATS, FACADE_GRID, FINISH_ATTRIBUTE, type KitBoxes, NORMAL_UNIT, PAINT_ATTRIBUTE, SHELL_MESH, SHELL_SHORTS, cellArrays, finishId, paintShort, snorm16,
} from './cellArrays';
import {
  COVER_INSET, GRIME_REACH, GROUND_ATTRIBUTE, LOOK_FLOATS, MACRO_SCALE, NO_GROUND, SHELL_PARTS, SHELL_PART_FACES, SHELL_PART_KINDS, type ShellPartKind, macroNoise,
} from './shellParts';
import { partLook } from './fade';

import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import {
  type Entrance,
  type Foundation,
  type GroundAt,
  type PavedAt,
  LANDING_RISE,
  PLINTH_BURY,
  STEP_RUN,
  flightRun,
  foundationOf,
  floorHeight,
} from '@world/buildings/foundation';
import {
  type FacadeBay,
  SIDE_NORMAL,
  bayWidth,
  baysOn,
  closedBlocks,
  coveredSpans,
  exposedParts,
  facadeBays,
  levelElevation,
  levelHeight,
  liftAt,
  projectionRect,
  ridgeAlongX,
  roofRise,
  roofHeightAt,
  roofSlope,
  sawtoothRun,
  shedFall,
  sideLength,
  sideStart,
  volumeElevation,
  volumeHeight,
  volumeLift,
} from '@world/buildings/geometry';
import {
  FINISHES,
  type Finish,
  type MaterialSpec,
  paletteOf,
  plinthMaterial,
  roofMaterial,
  trimMaterial,
  wallMaterial,
} from '@world/buildings/materials';
import { FOLLOWS_GROUND, elementRect, followPieces, onGround, partGroups, stairSteps, unsupportedElements } from '@world/buildings/elements';
import { isRetainingStone } from '@world/buildings/cityBuildings';
import { TERRAIN_CELL, TERRAIN_HALF } from '../terrainGrid';
import { highestGroundUnder } from './lawnGround';
import {
  type BayComponent,
  type Building,
  type BuildingElement,
  type FacadeGeometry,
  type Relief,
  type FaceId,
  type Side,
  SIDES,
  type Volume,
  type RoofDetail,
  volumeTop,
  type LotSurface,
} from '@world/buildings/types';
import { type BuildingKit, PART_KINDS, PORCH_LAMP, type PartKind } from './kit';
import { FACADE_FLIP, FACADE_KIND } from './facadeLevel';
import { gpuOnlyAttributes } from '../mesh/gpuOnly';
import { facadeProps } from './facadeProps';
import { LOT_COLOURS } from './massing';
import { PARASOL_HALF, PARASOL_HIGH, PARASOL_LOW, ROOF_COLOURS, TANK_COLOURS, machineRooms, roofPlantOf, terraceDeck, terraceParasols, terraceSeed } from './roofPlan';
import type { FlagInstance } from './flagLayer';
import type { BuildingChunk, LotGround, LotGroundRecipe, PartBatch, RunChunk, ShellChunk } from './chunk';
export type { BuildingChunk, LotGround, LotGroundRecipe, PartBatch,  } from './chunk';
import { drawsSignature } from './signature';
import { type Cover, type PartyWalls, hiddenByCovers } from './partyWalls';
import { type FlagDesign, legacyFlag } from '@world/buildings/flags';

/** Where the flags of the building being emitted go (`emitChunk` sets it). */
let flagSink: FlagInstance[] | null = null;
/** A roof part's flag, or null: its own design, else the fixed one it names. */
const flagOf = (detail: RoofDetail): FlagDesign | null =>
  !detail.flag || detail.flag === 'none' ? null : detail.flagDesign ?? legacyFlag(detail.flag);

/** Buildings, as meshes. */

export interface BuildingMeshes {
  readonly group: Group;
  readonly triangles: number;
  /** Shown or hidden as a whole. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** What `assembleBuildingMeshes` puts together, and where the shells go. */
export interface AssemblySelection {
  readonly parts: ReadonlySet<PartKind>;
  readonly shells: boolean;
  readonly furniture: boolean;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  colour?: Color;
  /** A window pane's space (`lightSlots.ts`): lit when its room is. */
  slot?: number;
  /** A window pane's room behind it (`roomBehind.ts`, ROOM_FLOATS numbers). */
  room?: readonly number[];
  /** A shell's part (`shellParts.ts`): its paint, and the shell's wear and ground where it was laid (`Shell.decay`, `Shell.ground`). */
  look?: { readonly paint: Paint; readonly decay: number; readonly ground: number };
}

type Rgb = readonly [number, number, number];

/** A surface's colour (linear) and the finish it is drawn with. */
interface Paint {
  readonly rgb: Rgb;
  readonly finish: Finish;
}

const linear = (hex: number, shade = 1): Rgb => {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
};

/** A building paint in its own colour: held to 70 % chroma the town read grey (the player, 2026-10-09). */
const paint = (m: MaterialSpec, shade = 1): Paint => ({ rgb: linear(m.colour, shade), finish: m.finish });

const TERRACE: Paint = paint({ finish: 'stone', colour: 0xb0a595 });
const ARCADE_FLOOR: Paint = paint({ finish: 'stone', colour: 0x9d968a });
const SAW_GLASS: Paint = paint({ finish: 'glass', colour: 0x3c5360 });
const ROOF_PLANT: Paint = paint({ finish: 'concrete', colour: ROOF_COLOURS.plant });

// The parts drawn with a colour per instance (`cellArrays.ts`); a part placed with no colour takes the old fixed one.
export { COLOURED_PARTS };
const WHITE_RGB: Rgb = [1, 1, 1];
const PART_DEFAULT_COLOUR: Partial<Record<PartKind, Rgb>> = { frame: linear(0xe8e6df), railing: linear(0x33373a), fin: linear(0xe8e6df), brise: linear(0xe8e6df), louvre: linear(0x3d6b45) };
/** The trim's colour as a three Color, one per paint. */
const trimColours = new WeakMap<Paint, Color>();
const trimColour = (p: Paint): Color => {
  let c = trimColours.get(p);
  if (!c) { c = new Color(p.rgb[0], p.rgb[1], p.rgb[2]); trimColours.set(p, c); }
  return c;
};

// ------------------------------------------------------------------ dimensions
const REVEAL = m(0.2);
/** The deepest opening the far level lays flat (its error, `massCells.ts` `FACADE_ERROR`): a loggia's deeper recess keeps its geometry. */
export const FLAT_DEPTH = m(0.3);
/** What a flattened bay's shader draws in its opening (`facadeLevel.ts`): the parts set into it are left out. */
const SHADER_DRAWN: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['glass', 'glassDark', 'frame', 'door', 'shutter']));
const BAND_OUT = m(0.07);
const BAND_H = m(0.22);
const CORNICE_OUT = m(0.16);
const PARAPET_H = m(0.85);
const PARAPET_T = m(0.25);
/** How far a part fitted inside another (a shutter in its frame) keeps off its edges, so no two faces share a plane. */
const PART_INSET = m(0.006);
/** A deep plain parapet: the attic band that crowns a block of the 'attic' dress. */
const ATTIC_H = m(1.5);
const EAVES = m(0.45);
/** Depth of a pitched roof's edge: rafter, battens and tiles, read at the fascia (18 cm). */
const ROOF_THICK = m(0.18);
const ARCADE = m(1.8);
const PLINTH_GROW = m(0.12);
/** How far a plinth's ledge and a door's threshold stand over the floor */
const PLINTH_RISE = LANDING_RISE;
/** How deep a loggia is let into the wall. */
const LOGGIA_DEPTH = m(1.4);
/** How far a varanda gourmet's slab stands out of the wall. */
const GOURMET_OUT = m(1.6);
/** How thick the side wall at the end of a run of varandas gourmet is. */
const GOURMET_CHEEK = m(0.2);
/** How far inside its bay that wall stands: off the bay's edge, where the slab and the next bay end. */
const CHEEK_IN = m(0.003);
/** How far under the storey's floor that wall starts: under the slab, at no height another part ends at. */
const CHEEK_FOOT = m(0.307);
/** How far into the building's wall that wall's back is let. */
const CHEEK_BURY = m(0.011);

interface Opening {
  a0: number;
  a1: number;
  h0: number;
  h1: number;
  depth: number;
}

/** The hole a component cuts in its bay, or null for a solid bay. */
function openingOf(component: BayComponent, W: number, H: number, geometry?: FacadeGeometry): Opening | null {
  let w: number;
  let h0: number;
  let h1: number;
  let depth = REVEAL;
  switch (component) {
    case 'window':
    case 'sashWindow':
      w = Math.min(W - m(1.1), m(1.5));
      h0 = m(0.9);
      h1 = H - m(0.55);
      break;
    case 'wideWindow':
      w = W - m(0.35);
      h0 = m(0.35);
      h1 = H - m(0.35);
      depth = m(0.12);
      break;
    case 'balcony':
      w = Math.min(W - m(0.9), m(1.7));
      h0 = m(0.02);
      h1 = H - m(0.5);
      break;
    case 'door':
      w = Math.min(W - m(0.9), m(1.3));
      h0 = 0;
      h1 = Math.min(H - m(0.4), m(2.35));
      break;
    case 'shopfront':
      w = W - m(0.3);
      h0 = m(0.35);
      h1 = H - m(0.8);
      depth = m(0.12);
      break;
    case 'loadingDoor':
      w = W - m(0.7);
      h0 = 0;
      h1 = Math.min(H - m(0.6), m(4.5));
      depth = m(0.25);
      break;
    // These had no opening at all: every double door, French window, bay window
    case 'doubleDoor':
      w = Math.min(W - m(0.7), m(2.4));
      h0 = 0;
      // A tall ground floor gets a fanlight over the door, up to 3.6 m.
      h1 = Math.min(H - m(0.45), m(3.6));
      depth = m(0.3);
      break;
    case 'frenchWindow':
      w = Math.min(W - m(0.9), m(1.6));
      h0 = m(0.05);
      h1 = H - m(0.5);
      break;
    case 'bayWindow':
      w = Math.min(W - m(0.8), m(2));
      h0 = m(0.75);
      h1 = H - m(0.5);
      depth = m(0.12);
      break;
    case 'ribbon':
      w = W - m(0.15);
      h0 = m(0.9);
      h1 = H - m(0.6);
      depth = m(0.1);
      break;
    case 'garageDoor':
      w = Math.min(W - m(0.8), m(3));
      h0 = 0;
      h1 = Math.min(H - m(0.5), m(2.6));
      depth = m(0.2);
      break;
    // The facade library (`world/buildings/architecture.ts`).
    case 'loggia':
      // Let into the wall the depth of a room's edge
      w = W - m(0.5);
      h0 = m(0.02);
      h1 = H - m(0.3);
      depth = LOGGIA_DEPTH;
      break;
    case 'brise':
      w = W - m(0.5);
      h0 = m(0.75);
      h1 = H - m(0.4);
      depth = m(0.15);
      break;
    case 'shutteredWindow':
      w = Math.min(W - m(1.6), m(1.2));
      h0 = m(0.85);
      h1 = H - m(0.45);
      break;
    case 'gourmet':
      w = W - m(0.4);
      h0 = m(0.02);
      h1 = H - m(0.35);
      depth = m(0.15);
      break;
    default:
      return null;
  }
  if (geometry && (component === 'window' || component === 'sashWindow' || component === 'wideWindow')) {
    if (geometry.windowWidth !== undefined) w = W * geometry.windowWidth;
    if (geometry.sill !== undefined) h0 = Math.min(geometry.sill, H - m(.65));
    if (geometry.windowHeight !== undefined) h1 = h0 + H * geometry.windowHeight;
  }
  w = Math.max(m(0.4), Math.min(w, W - m(0.2)));
  h1 = Math.max(h0 + m(0.5), Math.min(h1, H - m(0.15)));
  const a0 = (W - w) / 2;
  return { a0, a1: a0 + w, h0, h1, depth };
}

// ------------------------------------------------------------------ shell builder

type Typed = Float32Array | Int16Array | Uint16Array | Uint32Array | Uint8Array;

/** DO NOT lay a shell in number[]: 8 bytes a number and its regrowth, tens of MB of garbage a cell; a typed array that doubles as it fills, viewed at its length at the end */
class Grow<T extends Typed> {
  array: T;
  length = 0;
  constructor(private readonly make: (size: number) => T, size: number) {
    this.array = make(size);
  }

  /** The array, with room for `n` more numbers after `length` (a new one, twice as large, when full). */
  room(n: number): T {
    const need = this.length + n;
    if (need > this.array.length) {
      let size = this.array.length * 2;
      while (size < need) size *= 2;
      const next = this.make(size);
      (next as Typed).set(this.array);
      this.array = next;
    }
    return this.array;
  }

  /** What was written, without a copy. */
  view(): T {
    return this.array.subarray(0, this.length) as T;
  }

  /** The array's bytes as 32-bit words (a new view only once it grew): what the vertex weld hashes and compares. */
  bits(): Int32Array {
    const a = this.array;
    let w = this.words;
    if (!w || w.buffer !== a.buffer) w = this.words = new Int32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    return w;
  }

  private words: Int32Array | null = null;
}

/** One of a part's arrays as a vertex fills it: its numbers and its 32-bit words a vertex (every vertex whole words, so the weld reads them as words). */
interface Stream {
  readonly grow: Grow<Typed>;
  readonly size: number;
  readonly words: number;
}

/** A 32-bit word into a running hash (MurmurHash3's block step, A. Appleby). */
function hashWord(h: number, w: number): number {
  let k = Math.imul(w, 0xcc9e2d51);
  k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** One finish's share of a shell, written as laid in the GPU's layout (`ShellChunk`): flat-shaded, painted triangles, the uv worked out on the GPU. */
class ShellPart {
  vertices = 0;
  readonly position = new Grow((n) => new Float32Array(n), 3 * 64);
  /** The normal and the building's decay (`Building.decay`), for the weathering shader. */
  readonly normalDecay = new Grow((n) => new Int16Array(n), SHELL_SHORTS * 64);
  /** The paint, its tone and grime in it, and the finish id. */
  readonly paint = new Grow((n) => new Uint16Array(n), SHELL_SHORTS * 64);
  readonly index = new Grow((n) => new Uint32Array(n), 96);
  /** A run of bays only (`RunChunk`): each vertex's bay width and storey height (`FACADE_FLOATS`), its grid (`FACADE_GRID`), its opening in its bay (a0, a1, h0, h1), its frames' colour (r, g, b) and office flag (`FACADE_BYTES`, 0..255). */
  readonly facade: Grow<Float32Array> | null;
  readonly grid: Grow<Int16Array> | null;
  readonly opening: Grow<Uint8Array> | null;
  /** Every array a vertex is written in: two vertices alike in all of them, bit for bit, are drawn as one. */
  private readonly streams: readonly Stream[];
  /** The weld's table, open addressing with linear probing: each slot a vertex + 1, 0 empty; never more than half full. */
  private slots = new Int32Array(256);

  constructor(readonly finish: number, run: boolean) {
    this.facade = run ? new Grow((n) => new Float32Array(n), FACADE_FLOATS * 64) : null;
    this.grid = run ? new Grow((n) => new Int16Array(n), FACADE_GRID * 64) : null;
    this.opening = run ? new Grow((n) => new Uint8Array(n), FACADE_BYTES * 64) : null;
    const streams: Stream[] = [
      { grow: this.position, size: 3, words: 3 },
      { grow: this.normalDecay, size: SHELL_SHORTS, words: SHELL_SHORTS / 2 },
      { grow: this.paint, size: SHELL_SHORTS, words: SHELL_SHORTS / 2 },
    ];
    if (this.facade && this.grid && this.opening) {
      streams.push({ grow: this.facade, size: FACADE_FLOATS, words: FACADE_FLOATS }, { grow: this.grid, size: FACADE_GRID, words: FACADE_GRID / 2 }, { grow: this.opening, size: FACADE_BYTES, words: FACADE_BYTES / 4 });
    }
    this.streams = streams;
  }

  /** Room in every array for `count` vertices written from `vertices` on. */
  room(count: number): void {
    for (const s of this.streams) s.grow.room(count * s.size);
  }

  /** The vertex just written at `vertices`: kept as a new one, or the one laid before with every number alike; its index. */
  weld(): number {
    const v = this.vertices;
    if ((v + 1) * 2 > this.slots.length) this.rehash();
    const mask = this.slots.length - 1;
    for (let s = this.hash(v) & mask; ; s = (s + 1) & mask) {
      const at = this.slots[s]!;
      if (at === 0) {
        this.slots[s] = v + 1;
        this.vertices = v + 1;
        for (const st of this.streams) st.grow.length = this.vertices * st.size;
        return v;
      }
      if (this.same(at - 1, v)) return at - 1;
    }
  }

  private hash(v: number): number {
    let h = 0x2545f491;
    for (const { grow, words } of this.streams) {
      const bits = grow.bits();
      for (let k = v * words, end = k + words; k < end; k++) h = hashWord(h, bits[k]!);
    }
    // MurmurHash3's finaliser: every bit of the words reaches the low bits the table reads.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return h ^ (h >>> 16);
  }

  private same(a: number, b: number): boolean {
    for (const { grow, words } of this.streams) {
      const bits = grow.bits();
      for (let k = 0; k < words; k++) if (bits[a * words + k] !== bits[b * words + k]) return false;
    }
    return true;
  }

  /** A table twice the size, every vertex kept put in it again. */
  private rehash(): void {
    this.slots = new Int32Array(this.slots.length * 2);
    const mask = this.slots.length - 1;
    for (let v = 0; v < this.vertices; v++) {
      let s = this.hash(v) & mask;
      while (this.slots[s] !== 0) s = (s + 1) & mask;
      this.slots[s] = v + 1;
    }
  }
}

/** Each corner of the face being laid: the vertex it was welded to (grown for a lantern's 24-sided cap). */
let faceIds = new Int32Array(32);

/** What the windows of a run of bays are, for the far level's shader to draw them where the detail has them (`facadeLevel.ts`) */
interface FacadeStamp {
  /** `FACADE_KIND`. */
  readonly kind: number;
  readonly volume: number;
  readonly side: number;
  /** The run's direction along the facade, world plan. */
  readonly tx: number;
  readonly ty: number;
  /** One bay's width and one storey's height. */
  readonly W: number;
  readonly H: number;
  /** The opening in its bay, shares of W and H. */
  readonly opening: readonly [number, number, number, number];
  /** The frames' colour (the trim), linear 0..1. */
  readonly trim: readonly [number, number, number];
  /** Each point's bay (u) and level (v), whole numbers at the run's bay and storey lines. */
  readonly uv: readonly (readonly [number, number])[];
  /** Offices and shops: their lit rooms take the offices' lamps (`roomLamps.ts`). */
  readonly office: boolean;
}

/** A share 0..1 as a byte. */
const toByte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);

/** Triangles in THREE's axes, one buffer set per finish; winding fixed per face. */
class Shell {
  readonly parts = new Map<Finish, ShellPart>();
  /** The far level's runs of bays with openings, apart (`RunChunk`): only their vertices pay for the window grid. */
  readonly runs = new Map<Finish, ShellPart>();
  /** The ground floor's height for the building being emitted: walls darken towards it */
  ground = Number.NaN;
  /** How run-down the building being emitted is (`Building.decay`): stains, peeling paint, grime. */
  decay = 0;
  /** The far level being emitted (`emitChunk` `far`): its bays laid as runs, the runs with openings in `runs`. */
  far = false;
  /** The windows of the face being laid (the far level's runs of bays). */
  stamp: FacadeStamp | null = null;
  /** The elements' boxes as instances of the shell's parts (`shellParts.ts`, `emitChunk` `apart`); false lays them here face by face. */
  apart = true;

  /** DO NOT lay only the first two triangles: a lantern's octagonal and 24-sided caps */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], c: Paint, shades?: readonly number[]): void {
    // A run of bays with no opening (kind 0) draws as a wall: it needs no window grid.
    const st = this.stamp && this.stamp.kind !== FACADE_KIND.none ? this.stamp : null;
    const parts = st ? this.runs : this.parts;
    let part = parts.get(c.finish);
    if (!part) {
      part = new ShellPart(finishId(c.finish), st !== null);
      parts.set(c.finish, part);
    }
    const count = points.length;
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const wx = n[0] / length;
    const wy = n[1] / length;
    const wz = n[2] / length;
    const nx = wx;
    const ny = wz;
    const nz = -wy;
    const wall = Math.abs(wz) < 0.5;
    const grime = wall && Number.isFinite(this.ground);
    // Every vertex of every shell passes here (a town's opening: 2.5-3 s of its 6 s of buildings): straight into the GPU's layout, its uv worked out there (`shellUv`).
    part.room(count);
    const position = part.position.array, normalDecay = part.normalDecay.array, paint = part.paint.array;
    const qx = snorm16(nx), qy = snorm16(ny), qz = snorm16(nz), qd = snorm16(this.decay);
    const rgb = c.rgb;
    const id = part.finish;
    if (faceIds.length < count) faceIds = new Int32Array(count * 2);
    const ids = faceIds;
    const bytes = st ? this.runBytes(st) : null;
    const flip = st ? this.runFlip(st, wx, wy) : 0;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const x = p[0], y = p[1], z = p[2];
      // Written past the vertices kept: the weld keeps it, or finds it laid already and the next one writes over it.
      const v = part.vertices, p3 = v * 3, p4 = v * SHELL_SHORTS;
      // Each -0 written +0 (x + 0, 0 - y), so the two weld: the GPU draws them alike.
      position[p3] = x + 0; position[p3 + 1] = z + 0; position[p3 + 2] = 0 - y;
      // No two stretches of wall quite the same tone, and the base weathered.
      // A vertex's own shade (a streak under a sill darker at its foot, `emitStreak`).
      let tone = (0.97 + macroNoise(x / MACRO_SCALE, y / MACRO_SCALE, z / MACRO_SCALE) * 0.06) * (shades?.[i] ?? 1);
      if (grime) {
        const t = Math.min(1, Math.max(0, (z - this.ground) / GRIME_REACH));
        tone *= 0.8 + 0.2 * t * t * (3 - 2 * t);
      }
      normalDecay[p4] = qx; normalDecay[p4 + 1] = qy; normalDecay[p4 + 2] = qz; normalDecay[p4 + 3] = qd;
      paint[p4] = paintShort(rgb[0] * tone); paint[p4 + 1] = paintShort(rgb[1] * tone); paint[p4 + 2] = paintShort(rgb[2] * tone); paint[p4 + 3] = id;
      if (st && bytes) this.stampRun(part, v, st, i, flip, bytes);
      ids[i] = part.weld();
    }
    // In three's axes (x, z, -y): the winding measured against the normal.
    const p0 = points[0]!, p1 = points[1]!, p2 = points[2]!;
    const ux = p1[0] - p0[0], uy = p1[2] - p0[2], uz = p0[1] - p1[1];
    const vx = p2[0] - p0[0], vy = p2[2] - p0[2], vz = p0[1] - p2[1];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const forward = cx * nx + cy * ny + cz * nz >= 0;
    const index = part.index.room((count - 2) * 3);
    let k3 = part.index.length;
    for (let k = 1; k + 1 < count; k++) {
      index[k3++] = ids[0]!;
      index[k3++] = forward ? ids[k]! : ids[k + 1]!;
      index[k3++] = forward ? ids[k + 1]! : ids[k]!;
    }
    part.index.length = k3;
  }

  /** The run's bays go along the face's own horizontal (`shellUv`'s t, as the shader works it out) or against it: the shader turns it round; (wx, wy): the face's normal on the plan, world axes. */
  private runFlip(st: FacadeStamp, wx: number, wy: number): number {
    return Math.hypot(wx, wy) > 1e-6 && -wy * st.tx + wx * st.ty < 0 ? FACADE_FLIP : 0;
  }

  /** A run's opening and frames as bytes, the same on each of its vertices. */
  private runBytes(st: FacadeStamp): readonly number[] {
    return [toByte(st.opening[0]), toByte(st.opening[1]), toByte(st.opening[2]), toByte(st.opening[3]), toByte(st.trim[0]), toByte(st.trim[1]), toByte(st.trim[2]), st.office ? 255 : 0];
  }

  /** The window grid of the run's corner `i`, written at vertex `v` before it is welded. */
  private stampRun(part: ShellPart, v: number, st: FacadeStamp, i: number, flip: number, bytes: readonly number[]): void {
    const facade = part.facade!.array, grid = part.grid!.array, opening = part.opening!.array;
    const [u, w] = st.uv[i]!;
    const f = v * FACADE_FLOATS, g = v * FACADE_GRID, o = v * FACADE_BYTES;
    facade[f] = st.W; facade[f + 1] = st.H;
    grid[g] = u; grid[g + 1] = w; grid[g + 2] = st.kind + flip; grid[g + 3] = st.volume * 4 + st.side;
    for (let k = 0; k < FACADE_BYTES; k++) opening[o + k] = bytes[k]!;
  }

  get triangles(): number {
    let n = 0;
    for (const parts of [this.parts, this.runs]) for (const part of parts.values()) n += part.index.length / 3;
    return n;
  }
}

type V3 = [number, number, number];

/** A face of one bay: its frame in the building's local plan, and its storey. */
interface BayFace {
  /** Local start of the bay on the facade line, its along direction and outward normal. */
  ax: number;
  ay: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  z0: number;
  W: number;
  H: number;
}

/** The frame of a face of `side`, starting `along` units from the side's start, its plane `push` units out from the side */
function sideFrame(v: Volume, side: FaceId, along: number, push = 0): Pick<BayFace, 'ax' | 'ay' | 'tx' | 'ty' | 'nx' | 'ny'> {
  const s = sideStart(v, side);
  const edge = edgeFrame(v, side);
  const n = { x: edge.nx, y: edge.ny };
  return { ax: s.x + s.tx * along + n.x * push, ay: s.y + s.ty * along + n.y * push, tx: s.tx, ty: s.ty, nx: n.x, ny: n.y };
}

// ------------------------------------------------------------------ one building

class Emitter {
  private readonly c: number;
  private readonly s: number;
  readonly parts: Record<PartKind, Placement[]>;

  constructor(
    private readonly b: Building,
    readonly shell: Shell,
    parts: Record<PartKind, Placement[]>,
    /** Furniture pieces, by kind, drawn instanced from the furniture kit. */
    readonly furniture: Partial<Record<FurnitureKind, Placement[]>> = {},
  ) {
    this.c = Math.cos(b.rotation);
    this.s = Math.sin(b.rotation);
    this.parts = parts;
  }

  /** The building being emitted. */
  get building(): Building {
    return this.b;
  }

  /** A local plan point at absolute height z, in world axes. */
  L(lx: number, ly: number, z: number): V3 {
    return [this.b.x + lx * this.c - ly * this.s, this.b.y + lx * this.s + ly * this.c, z];
  }

  /** A local direction as a world normal. */
  N(dx: number, dy: number, dz = 0): V3 {
    return [dx * this.c - dy * this.s, dx * this.s + dy * this.c, dz];
  }

  /** A point on a bay face: `a` along, `h` up, `depth` into the wall. */
  P(f: BayFace, a: number, h: number, depth: number): V3 {
    return this.L(f.ax + f.tx * a - f.nx * depth, f.ay + f.ty * a - f.ny * depth, f.z0 + h);
  }

  /** A rectangle on (or parallel to) a bay face. */
  rect(f: BayFace, a0: number, a1: number, h0: number, h1: number, depth: number, n: V3, c: Paint): void {
    if (a1 - a0 < 1e-4 || h1 - h0 < 1e-4) return;
    this.shell.face([this.P(f, a0, h0, depth), this.P(f, a1, h0, depth), this.P(f, a1, h1, depth), this.P(f, a0, h1, depth)], n, c);
  }

  /** An axis-aligned box in the local plan: sides and top (the bottom is never seen). */
  /** A round tank or drum: an upright prism of `sides` faces, capped on top. */
  cylinder(cx: number, cy: number, r: number, z0: number, z1: number, c: Paint, top: Paint = c, sides = 14): void {
    const sh = this.shell;
    const at = (k: number): [number, number] => [cx + Math.cos((k / sides) * Math.PI * 2) * r, cy + Math.sin((k / sides) * Math.PI * 2) * r];
    for (let k = 0; k < sides; k++) {
      const [ax, ay] = at(k), [bx, by] = at(k + 1);
      const mid = ((k + 0.5) / sides) * Math.PI * 2;
      sh.face([this.L(ax, ay, z0), this.L(bx, by, z0), this.L(bx, by, z1), this.L(ax, ay, z1)], this.N(Math.cos(mid), Math.sin(mid)), c);
      sh.face([this.L(cx, cy, z1), this.L(ax, ay, z1), this.L(bx, by, z1)], [0, 0, 1], top);
    }
  }

  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: Paint, top: Paint = c): void {
    if (z1 - z0 < 1e-4) return;
    // An element's box of one paint: an instance of the shell's box, its look laid as these faces' (`shellParts.ts`).
    if (this.apart && top === c && x1 - x0 > 1e-6 && y1 - y0 > 1e-6) {
      this.shellPart('lotBox', (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, x1 - x0, y1 - y0, 0, c);
      return;
    }
    const sh = this.shell;
    sh.face([this.L(x0, y0, z0), this.L(x1, y0, z0), this.L(x1, y0, z1), this.L(x0, y0, z1)], this.N(0, -1), c);
    sh.face([this.L(x1, y1, z0), this.L(x0, y1, z0), this.L(x0, y1, z1), this.L(x1, y1, z1)], this.N(0, 1), c);
    sh.face([this.L(x1, y0, z0), this.L(x1, y1, z0), this.L(x1, y1, z1), this.L(x1, y0, z1)], this.N(1, 0), c);
    sh.face([this.L(x0, y1, z0), this.L(x0, y0, z0), this.L(x0, y0, z1), this.L(x0, y1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], [0, 0, 1], top);
  }

  /** A box whose sides stand `inset` in from the edges of its top. */
  slab(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, inset: number, c: Paint): void {
    if (z1 - z0 < 1e-4 || x1 - x0 <= 2 * inset || y1 - y0 <= 2 * inset) return;
    // An element's paving: an instance of the shell's, its sides stood in by its program (`shellParts.ts` `COVER_INSET`).
    if (this.apart && inset === COVER_INSET) {
      this.shellPart('lotSlab', (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, x1 - x0, y1 - y0, 0, c);
      return;
    }
    const sh = this.shell;
    const [a0, b0, a1, b1] = [x0 + inset, y0 + inset, x1 - inset, y1 - inset];
    sh.face([this.L(a0, b0, z0), this.L(a1, b0, z0), this.L(a1, b0, z1), this.L(a0, b0, z1)], this.N(0, -1), c);
    sh.face([this.L(a1, b1, z0), this.L(a0, b1, z0), this.L(a0, b1, z1), this.L(a1, b1, z1)], this.N(0, 1), c);
    sh.face([this.L(a1, b0, z0), this.L(a1, b1, z0), this.L(a1, b1, z1), this.L(a1, b0, z1)], this.N(1, 0), c);
    sh.face([this.L(a0, b1, z0), this.L(a0, b0, z0), this.L(a0, b0, z1), this.L(a0, b1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], [0, 0, 1], c);
  }

  /** A horizontal strip at height h, from depth d0 to d1 into the wall. */
  strip(f: BayFace, a0: number, a1: number, h: number, d0: number, d1: number, n: V3, c: Paint): void {
    this.shell.face([this.P(f, a0, h, d0), this.P(f, a1, h, d0), this.P(f, a1, h, d1), this.P(f, a0, h, d1)], n, c);
  }

  /** A vertical strip across the wall's thickness at `a`, from h0 to h1. */
  jamb(f: BayFace, a: number, h0: number, h1: number, d0: number, d1: number, n: V3, c: Paint): void {
    this.shell.face([this.P(f, a, h0, d0), this.P(f, a, h0, d1), this.P(f, a, h1, d1), this.P(f, a, h1, d0)], n, c);
  }

  /** An instance placed on a bay face, turned so its local +Z is the face's outward normal. */
  /** The space of the bay being drawn, for its panes (-1: none). */
  slot = -1;
  /** The room behind a pane centred `a` along the bay and `h` up it, for the bay being emitted (`roomBehind.ts`). */
  room: ((a: number, h: number) => readonly number[]) | null = null;
  /** The bay being emitted is flattened (the far level, `emitChunk` `far`): its wall and opening laid by `emitFacadeRuns`. */
  flat = false;

  put(kind: PartKind, f: BayFace, a: number, h: number, depth: number, sx: number, sy: number, sz: number, colour?: Color, turn = 0): void {
    // A flattened bay of the far level: what is set into its opening is drawn by the shader (`facadeLevel.ts`).
    if (this.flat && depth > 0 && SHADER_DRAWN.has(kind)) return;
    const p = this.P(f, a, h, depth);
    const n = this.N(f.nx, f.ny);
    const placement: Placement = { x: p[0], y: p[1], z: p[2], yaw: Math.atan2(n[0], -n[1]) + turn, sx, sy, sz };
    if (colour) placement.colour = colour;
    if (kind === 'glass' || kind === 'glassDark') {
      placement.slot = this.slot;
      if (this.room) placement.room = this.room(a, h);
    }
    this.parts[kind].push(placement);
  }

  /** An element being emitted (`emitElement`): its boxes are the shell's parts where the shell lets them be (`Shell.apart`). */
  inElement = false;
  get apart(): boolean {
    return this.inElement && this.shell.apart;
  }

  /** A shell's part (`shellParts.ts`) centred at plan point (lx, ly), from z0 to z1, `along` its own x turned `turn` from the building's and `across` it. */
  shellPart(kind: ShellPartKind, lx: number, ly: number, z0: number, z1: number, along: number, across: number, turn: number, c: Paint): void {
    const p = this.L(lx, ly, (z0 + z1) / 2);
    const look = { paint: c, decay: this.shell.decay, ground: this.shell.ground };
    this.parts[kind].push({ x: p[0], y: p[1], z: p[2], yaw: this.b.rotation + turn, sx: along, sy: z1 - z0, sz: across, look });
  }

  /** An instance at a point of the building's plan (`L`), square to the building, its centre at height `z`. */
  putAt(kind: PartKind, lx: number, ly: number, z: number, sx: number, sy: number, sz: number): void {
    const p = this.L(lx, ly, z);
    const n = this.N(0, 1);
    this.parts[kind].push({ x: p[0], y: p[1], z: p[2], yaw: Math.atan2(n[0], -n[1]), sx, sy, sz });
  }
}

/** How far its light reaches over the wall round it, either way and up or down. */
const PORCH_WASH = { half: m(1.1), up: m(1.3) } as const;

/** The lantern beside a front door, a little under the door's head, on the side where the bay's wall has room for it */
function emitPorchLight(e: Emitter, f: BayFace, W: number, am: number, w: number, top: number): void {
  const right = am + w / 2 + PORCH_LAMP.gap;
  const left = am - w / 2 - PORCH_LAMP.gap;
  const room = PORCH_LAMP.w / 2 + m(0.05);
  const a = right + room <= W ? right : left - room >= 0 ? left : null;
  if (a === null) return;
  const h = top - m(0.25);
  e.put('lamp', f, a, h, -PORCH_LAMP.d / 2, PORCH_LAMP.w, PORCH_LAMP.h, PORCH_LAMP.d);
  const half = Math.min(PORCH_WASH.half, a, W - a);
  const up = Math.min(PORCH_WASH.up, h + m(0.3));
  // At the lantern's own centre, so it is switched with it (`kit.ts`, the wash plane is drawn back on the wall).
  e.put('wash', f, a, h, -PORCH_LAMP.d / 2, half * 2, up * 2, 1);
}

/** The light slot of a bay's window: the space on its floor behind it. */
/** Who gives a space its seed for its windows' light (`lightSlots.ts` `spaceSeed`; a test may give its own). */
export type SlotAllocator = (building: number, level: number, volume: number, x: number, y: number) => number;

function slotOfBay(b: Building, v: Volume, bay: FacadeBay, spaces: ReturnType<typeof deriveSpaces>, slots: SlotAllocator): number {
  if (b.id < 0) return -1;
  const floor = spaces.find((f) => f.volume === v.id && f.level === bay.level);
  if (!floor) return -1;
  // A step inside the facade, in the building's frame.
  const inside = worldToLocal(b, { x: bay.x - bay.nx * m(0.6) + 0, y: bay.y - bay.ny * m(0.6) });
  const along = (bay.width ?? 0) / 2;
  void along;
  const sp = floor.spaces.find((q) => inside.x >= q.x - 1 && inside.x <= q.x + q.w + 1 && inside.y >= q.y - 1 && inside.y <= q.y + q.d + 1)
    ?? floor.spaces[0];
  return sp ? slots(b.id, bay.level, v.id, sp.x, sp.y) : -1;
}

function emitBuilding(
  b: Building,
  groundAt: GroundAt,
  shell: Shell,
  parts: Record<PartKind, Placement[]>,
  pavedAt?: PavedAt,
  furniture: Partial<Record<FurnitureKind, Placement[]>> = {},
  onLot?: (el: BuildingElement) => boolean,
  designedFloor?: number,
  slots: SlotAllocator = spaceSeed,
  /** The neighbours' blocks a party wall stands against (`partyWalls.ts`): a bay inside them is not laid. */
  covers: readonly Cover[] = [],
): Foundation {
  const e = new Emitter(b, shell, parts, furniture);
  // Put in the world off the layout kept for the blocks (`bayLayout`): the flights' feet and the like buildings of the job read the same one.
  const bays = facadeBays(b);
  const f: Foundation = foundationOf(b, groundAt, bays, pavedAt, designedFloor);
  const floor = f.floor;
  shell.ground = floor;
  const entranceKey = (volume: number, side: FaceId, index: number): string => `${volume}:${side}:${index}`;
  const entrances = new Map<string, Entrance>(f.entrances.map((x) => [entranceKey(x.volume, x.side, x.index), x]));
  /** The opening of an entrance, in its bay's face frame. */
  const entranceOpening = (x: Entrance): Opening =>
    openingOf(x.component, x.width, levelHeight(b, 0)) ??
    { a0: x.width * 0.2, a1: x.width * 0.8, h0: 0, h1: levelHeight(b, 0) * 0.7, depth: REVEAL };
  /** Where an entrance's bay starts along its side. */
  const entranceStart = (x: Entrance, v: Volume): number => x.index * bayWidth(b, v, x.side);
  // A small, stable shade per building, so a street of one preset is not a single flat colour.
  const shade = 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;
  const wallOf = (v: Volume, side: FaceId, storey?: number): Paint => paint(wallMaterial(b, v, side, storey), shade);
  // Mouldings - bands, cornices, copings, reveals - are smooth: a finish with a pattern
  const trimSpec = trimMaterial(b);
  const frameTrim = paint({ finish: trimSpec.finish === 'metal' ? 'metal' : 'plaster', colour: trimSpec.colour });
  // Mouldings - cornices, string courses, copings, the heads of reliefs - are masonry
  const trim = trimSpec.finish === 'metal' && b.materials?.wall
    ? shaded(paint({ finish: 'plaster', colour: b.materials.wall.colour }), 1.1) : frameTrim;
  const plinth = paint(plinthMaterial(b));
  const awning = new Color().setHex(paletteOf(b).awning);

  // ---- plinth: from below the lowest ground up to the floor
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const top = floor + volumeLift(v);
    const notches = new Map<FaceId, { a0: number; a1: number; recess: number }[]>();
    for (const x of f.entrances) {
      if (x.volume !== v.id || x.recess <= 0) continue;
      const o = entranceOpening(x);
      const frame = sideFrame(v, x.side, entranceStart(x, v));
      const start = x.side === 0 || x.side === 2 ? frame.ax : frame.ay;
      const list = notches.get(x.side) ?? [];
      list.push({ a0: start + o.a0, a1: start + o.a1, recess: x.recess });
      notches.set(x.side, list);
    }
    // Its ledge a little over the floor (`PLINTH_RISE`), so a yard laid at the floor's level meets its face, not its top.
    const ledge = top + PLINTH_RISE;
    emitPlinth(e, b, v, Math.min(f.bottom, top - PLINTH_BURY), ledge, plinth, notches);
    // A projection standing on the ground stands on the plinth too.
    for (const r of v.reliefs ?? []) {
      const rect = r.storey0 === 0 ? projectionRect(b, v, r) : null;
      if (!rect) continue;
      const g = PLINTH_GROW;
      if (v.outline) {
        const frame = edgeFrame(v, r.side), width = bayWidth(b, v, r.side);
        const a0 = r.bay0 * width - g, a1 = (r.bay1 + 1) * width + g;
        const at = (a: number, depth: number, z: number): V3 =>
          e.L(frame.x + frame.tx * a + frame.nx * depth, frame.y + frame.ty * a + frame.ny * depth, z);
        e.shell.face([at(a0, r.depth + g, f.bottom), at(a1, r.depth + g, f.bottom), at(a1, r.depth + g, ledge), at(a0, r.depth + g, ledge)], e.N(frame.nx, frame.ny), plinth);
        e.shell.face([at(a0, -g, ledge), at(a1, -g, ledge), at(a1, r.depth + g, ledge), at(a0, r.depth + g, ledge)], [0, 0, 1], plinth);
      } else {
        e.box(rect[0] - g, rect[1] - g, rect[2] + g, rect[3] + g, f.bottom, ledge, plinth);
      }
    }
  }

  // The spaces of each floor, for which room a window lights.
  const spacesOf = deriveSpaces(b);
  // ---- facades, bay by bay: only outside walls are in `bays`
  const componentAt = new Map<string, BayComponent>();
  for (const bay of bays) componentAt.set(`${bay.volume}:${bay.level}:${bay.side}:${bay.index}`, bay.component);
  const volumes = new Map(b.volumes.map((v) => [v.id, v]));
  // The rooms behind the windows, a type of floor of a block at a time: the interior the cut-open view draws (`interiorAt`, furnished once a type for the blocks).
  const roomsOf = new Map<readonly Furniture[], Map<number, ReturnType<typeof roomsOfStorey>>>();
  // The far level's bays, laid as runs once all are known.
  const farBays: FarBay[] = [];
  for (const bay of bays) {
    const v = volumes.get(bay.volume) as Volume;
    const face: BayFace = { ...sideFrame(v, bay.side, bay.start, bay.push), z0: floor + bay.z, W: bay.width, H: bay.height };
    if (covers.length > 0) {
      const [x, y] = e.L(face.ax, face.ay, 0), [tx, ty] = e.N(face.tx, face.ty), [nx, ny] = e.N(face.nx, face.ny);
      if (hiddenByCovers(covers, x, y, tx, ty, nx, ny, face.W, face.z0, face.z0 + face.H)) continue;
    }
    const left = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index - 1}`);
    const right = componentAt.get(`${bay.volume}:${bay.level}:${bay.side}:${bay.index + 1}`);
    const recess = bay.level === 0 ? entrances.get(entranceKey(bay.volume, bay.side, bay.index))?.recess ?? 0 : 0;
    const composition = v.storeys[bay.storey]?.facade;
    const grammar = composition?.patterns?.[bay.side] ?? composition?.pattern ?? v.facadePattern;
    const controls = v.facadeGeometry?.[bay.side];
    if (grammar === 'observation' && bay.component === 'wideWindow') {
      const mullion = Math.min(m(0.12), face.W * .12);
      const head = Math.min(m(0.25), face.H * .12);
      const glass = paint({ finish: 'glass', colour: 0x526b73 });
      const frame = paint({ finish: 'metal', colour: 0xd5d5ca });
      e.rect(face, mullion, face.W - mullion, head, face.H - head, -m(.11), e.N(face.nx, face.ny), glass);
      e.rect(face, 0, mullion, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, face.W - mullion, face.W, 0, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, 0, head, -m(.16), e.N(face.nx, face.ny), frame);
      e.rect(face, 0, face.W, face.H - head, face.H, -m(.16), e.N(face.nx, face.ny), frame);
      continue;
    }
    // Cut open, the floor seen is walled as The Sims walls it
    if (b.cutaway !== undefined && bay.level === b.cutaway && b.cutView) {
      const n = e.N(face.nx, face.ny);
      const inner = paint({ finish: 'plaster', colour: 0xeee8dc });
      if (n[0] * b.cutView.x + n[1] * b.cutView.y < 0) {
        const low = Math.min(m(0.9), face.H);
        e.rect(face, 0, face.W, 0, low, 0, n, wallOf(v, bay.side, bay.storey));
        e.rect(face, 0, face.W, 0, low, m(0.25), e.N(-face.nx, -face.ny), inner);
        e.shell.face([e.P(face, 0, low, 0), e.P(face, face.W, low, 0), e.P(face, face.W, low, m(0.25)), e.P(face, 0, low, m(0.25))], [0, 0, 1], inner);
        continue;
      }
      e.rect(face, 0, face.W, 0, face.H, m(0.25), e.N(-face.nx, -face.ny), inner);
    }
    const opening = shell.far && bay.component !== 'pillar' && recess <= 0 ? openingOf(bay.component, bay.width, bay.height, controls) : undefined;
    if (opening !== undefined && (opening === null || opening.depth <= FLAT_DEPTH)) {
      // The far level: the bay's wall is laid with its storey's run (`emitFacadeRuns`), its opening drawn by the shader;
      // what stands out of it (balconies, awnings, canopies, sills, shutters' leaves) is put as in the detail.
      farBays.push({ bay, wall: wallOf(v, bay.side, bay.storey), opening, ground: floor + volumeLift(v) });
      shell.ground = floor + volumeLift(v);
      e.flat = true;
      emitBay(e, face, bay, wallOf(v, bay.side, bay.storey), frameTrim, awning, left, right, recess, controls);
      e.flat = false;
      shell.ground = floor;
    } else {
      e.slot = slotOfBay(b, v, bay, spacesOf, slots);
      if (b.id >= 0 && b.cutaway === undefined) {
        // The levels of one type share their pieces (`interiorAt`), and so their rooms, a pane alike looked at once.
        const inside = interiorAt(b, bay.level);
        let byBlock = roomsOf.get(inside.furniture);
        if (!byBlock) roomsOf.set(inside.furniture, byBlock = new Map());
        let look = byBlock.get(v.id);
        if (!look) byBlock.set(v.id, look = roomsOfStorey(b, v, inside, bay.level));
        const behind = look;
        e.room = (a, h) => behind(face.ax, face.ay, face.tx, face.ty, face.nx, face.ny, a, h, face.H - m(0.3));
      }
      // The base weathered at the block's own foot (a split level stands at its own floor).
      shell.ground = floor + volumeLift(v);
      emitBay(e, face, bay, wallOf(v, bay.side, bay.storey), frameTrim, awning, left, right, recess, controls);
      shell.ground = floor;
      e.slot = -1;
      e.room = null;
    }
    const ribDepth = controls?.pierDepth ?? (grammar === 'artDecoCrown' ? m(.65) : grammar === 'artDeco' ? m(.3) : 0);
    if (ribDepth > 0 && bay.index % (controls?.pierEvery ?? 1) === 0) {
      // Shallow, continuous-looking stone pilasters give every mass a vertical rhythm while retaining individually editable
      const width = Math.min(controls?.pierWidth ?? (grammar === 'artDecoCrown' ? m(.65) : m(.36)), face.W * .3);
      const a0 = width * 0.35, a1 = a0 + width;
      const depth = -ribDepth;
      // The building's own skin, a little lighter (catching the light)
      const stone = shaded(wallOf(v, bay.side, bay.storey), 1.08);
      // On the ground floor from the plinth's ledge up, not through it.
      const foot = bay.storey === 0 && v.base === 0 ? PLINTH_RISE : 0;
      e.rect(face, a0, a1, foot, face.H, depth, e.N(face.nx, face.ny), stone);
      e.jamb(face, a0, foot, face.H, 0, depth, e.N(-face.tx, -face.ty), stone);
      e.jamb(face, a1, foot, face.H, depth, 0, e.N(face.tx, face.ty), stone);
    }
  }
  if (farBays.length > 0) emitFacadeRuns(e, volumes, floor, farBays, frameTrim);

  // ---- reliefs: the cheeks, head and sill of every face region pushed in or out
  for (const v of b.volumes) {
    for (const r of v.reliefs ?? []) emitRelief(e, b, v, r, floor, wallOf(v, r.side, r.storey0), trim);
  }

  // ---- storey bands and cornices, per volume
  for (const v of b.volumes) {
    const lines = v.dress?.lines ?? 'every';
    if (lines === 'none') continue;
    for (let k = 1; k < v.storeys.length; k++) {
      const level = v.base + k;
      if (level === 0) continue;
      const z = floor + volumeElevation(b, v, level);
      // Not where another block stands against the wall over and under the line
      const hidden = (side: FaceId): [number, number][] => bothCovered(coveredSpans(b, v, side, level - 1), coveredSpans(b, v, side, level));
      if (lines === 'every') band(e, v, z, BAND_OUT, BAND_H, trim, hidden);
      // One string course over the ground floor: the base read from the body.
      else if (lines === 'base') { if (level === 1) band(e, v, z, m(0.12), m(0.32), trim, hidden); }
      // The floor slabs shown flush, a thin line of the wall's own render, darker.
      else flushBand(e, v, z, m(0.03), m(0.24), shaded(wallOf(v, 0), 0.86), hidden);
    }
  }

  // ---- roofs (none over a floor cut open to look inside)
  for (const v of b.volumes) {
    if (b.cutaway !== undefined && volumeTop(v) === b.cutaway + 1) continue;
    emitRoof(e, b, v, floor, (side) => wallOf(v, side), trim, paint(roofMaterial(b, v)));
    emitRoofDetails(e, b, v, floor);
  }
  if (b.cutaway !== undefined) emitInterior(e, b, floor, b.cutaway);

  // ---- entrance steps: outside, down to the ground in front
  for (const entrance of f.entrances) {
    if (entrance.steps <= 0) continue;
    const v = volumes.get(entrance.volume) as Volume;
    const frame = sideFrame(v, entrance.side, entranceStart(entrance, v), entrance.push);
    // The floor the door opens from: its own block's, on a split level.
    const level = entrance.floor;
    const face: BayFace = { ...frame, z0: level, W: entrance.width, H: 1 };
    const opening = entranceOpening(entrance);
    const n = e.N(face.nx, face.ny);
    const bottom = Math.min(entrance.ground, level) - m(0.4);
    // Every riser the same: the flight spans exactly ground to floor.
    const riser = (level - entrance.ground) / entrance.steps;
    if (entrance.recess > 0) {
      emitRecessedFlight(e, face, opening.a0, opening.a1, entrance, level, bottom, riser, plinth);
      continue;
    }
    const halfW = (opening.a1 - opening.a0 + m(0.5)) / 2;
    for (let j = 0; j < entrance.steps; j++) {
      const top = level - j * riser;
      const d0 = -(j === 0 ? 0 : STEP_RUN * (j + 1));
      const d1 = -STEP_RUN * (j + 2);
      const a0 = entrance.width / 2 - halfW;
      const a1 = entrance.width / 2 + halfW;
      // Front, top and the two cheeks of this step's block.
      e.rect(face, a0, a1, bottom - level, top - level, d1, n, plinth);
      shell.face([e.P(face, a0, top - level, d0), e.P(face, a1, top - level, d0), e.P(face, a1, top - level, d1), e.P(face, a0, top - level, d1)], [0, 0, 1], plinth);
      const tv = e.N(face.tx, face.ty);
      shell.face([e.P(face, a1, bottom - level, d0), e.P(face, a1, bottom - level, d1), e.P(face, a1, top - level, d1), e.P(face, a1, top - level, d0)], tv, plinth);
      shell.face([e.P(face, a0, bottom - level, d1), e.P(face, a0, bottom - level, d0), e.P(face, a0, top - level, d0), e.P(face, a0, top - level, d1)], [-tv[0], -tv[1], 0], plinth);
    }
  }

  // ---- the lot: a paved apron round the base, and a path to the street
  emitLot(e, b, f, groundAt, pavedAt);

  // ---- free elements: stairs, ramps, pillars, canopies, walls, slabs
  const loose = looseParts(b);
  for (const el of b.elements ?? []) {
    // Whatever stands on the building's open lot is laid with the lot.
    if (onLot?.(el) || loose?.has(el.id)) continue;
    // Cut open, what hangs above the cut floor (a clock, a canopy) goes with the floors above.
    if (b.cutaway !== undefined && el.z >= levelElevation(b, b.cutaway + 1) - 1e-6) continue;
    const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
    if (!FOLLOWS_GROUND.has(el.kind)) {
      emitElement(e, el, floor, f.bottom, look);
      continue;
    }
    // On the land: each step of it on the ground under it, its foot below that.
    for (const piece of followPieces(el)) {
      const w = e.L(piece.x, piece.y, 0);
      const ground = groundAt(w[0], w[1]);
      emitElement(e, piece, ground, ground - m(0.3), look);
    }
  }

  // ---- cores: a lift overrun on the highest flat roof over the core (`roofPlan.ts`)
  for (const { volume: best, x0, y0, x1, y1 } of machineRooms(b)) {
    const z = floor + volumeHeight(b, best);
    // The machine room clad in the building's own skin: a white box on every tower top read as a separate thing set on it.
    const skin = best.dress ? wallOf(best, 0) : trim;
    e.box(x0, y0, x1, y1, z, z + m(3), skin.finish === 'glass' ? MACHINE_ROOM : skin, ROOF_PLANT);
  }
  return f;
}

const FLOOR_FINISH = paint({ finish: 'stone', colour: 0xb9b2a5 });
/** A machine room's walls where the building's skin is glass: rendered blockwork. */
const MACHINE_ROOM = paint({ finish: 'concrete', colour: 0xa7a49c });
/** A parapet's metal coping: aluminium flashing. */
const ALUMINIUM_COPING = paint({ finish: 'metal', colour: 0xb9bcbd });

/** A parapet's coping: the trim where it is a masonry moulding of a quiet colour (a stone or rendered cap) */
function copingOf(trim: Paint): Paint {
  const [r, g, b] = trim.rgb;
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  const strong = hi > 1e-6 && (hi - lo) / hi > 0.45;
  return trim.finish === 'metal' || trim.finish === 'glass' || strong ? ALUMINIUM_COPING : trim;
}
const WOOD_FLOOR = paint({ finish: 'wood', colour: 0xa27548 });
const PORCELAIN_FLOOR = paint({ finish: 'stone', colour: 0xd9d3c7 });
const SHAFT = paint({ finish: 'concrete', colour: 0xb9b6ae });
const CAB = paint({ finish: 'metal', colour: 0x9aa3a8 });
const STEP = paint({ finish: 'stone', colour: 0xc9c2b3 });

/** Inside a building cut open at level `cut` (the Construction tool's interior view) */
function emitInterior(e: Emitter, b: Building, floor: number, cut: number): void {
  // The cut floor's height where a point of the plan is: each block's own, on a split level (`Volume.lift`).
  const zAt = (x: number, y: number): number => floor + liftAt(b, cut, x, y) + levelElevation(b, cut);
  // Homes and hotels have wooden floors; everywhere else, stone (the windows show the same, `roomBehind.ts`).
  const kind = floorKind(b, cut);
  const floorLook = kind === 1 ? FLOOR_FINISH : kind === 2 ? PORCELAIN_FLOOR : WOOD_FLOOR;
  for (const v of b.volumes) {
    if (v.mode === 'void' || v.mode === 'intersect' || v.open) continue;
    if (!(v.base <= cut && volumeTop(v) > cut)) continue;
    const z = floor + volumeElevation(b, v, cut);
    const flat = localFootprint(v).flatMap((p) => [p.x, p.y]);
    const triangles = earcut(flat);
    for (let i = 0; i < triangles.length; i += 3) {
      const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z + 0.04));
      e.shell.face(p as [V3, V3, V3], [0, 0, 1], floorLook);
    }
  }
  const u = b.module;
  const wall = m(0.2);
  for (const core of b.cores) {
    if (core.from > cut || core.to < cut) continue;
    const w = core.kind === 'stair' ? u * 2 : u;
    const x0 = core.x, y0 = core.y, x1 = core.x + w, y1 = core.y + u;
    const lift = liftAt(b, cut, x0 + w / 2, y0 + u / 2);
    const z = floor + lift + levelElevation(b, cut);
    const top = floor + lift + levelElevation(b, cut + 1) - m(0.3);
    const z0 = floor + lift + levelElevation(b, core.from);
    // The shaft: four walls, the front one with a doorway at this floor.
    e.box(x0, y1 - wall, x1, y1, z0, top, SHAFT);
    e.box(x0, y0, x0 + wall, y1, z0, top, SHAFT);
    e.box(x1 - wall, y0, x1, y1, z0, top, SHAFT);
    const door = Math.min(w * 0.5, m(1.2));
    const mid = (x0 + x1) / 2;
    e.box(x0, y0, mid - door / 2, y0 + wall, z0, top, SHAFT);
    e.box(mid + door / 2, y0, x1, y0 + wall, z0, top, SHAFT);
    e.box(mid - door / 2, y0, mid + door / 2, y0 + wall, z + m(2.2), top, SHAFT);
    if (core.kind === 'lift' || core.kind === 'stairLift') {
      // The car, standing at this floor.
      e.box(x0 + wall + m(0.1), y0 + wall + m(0.1), x1 - wall - m(0.1), y1 - wall - m(0.1), z + 0.05, z + m(2.3), CAB);
    }
    if (core.kind === 'stair' || core.kind === 'stairLift') {
      // A flight rising along the back of the shaft, and the landing.
      const steps = 12;
      const run = (x1 - x0 - 2 * wall) / steps;
      const rise = levelHeight(b, cut) / steps;
      for (let k = 0; k < steps; k++) {
        const sx = x0 + wall + k * run;
        e.box(sx, y0 + (y1 - y0) / 2, sx + run, y1 - wall, z, z + rise * (k + 1), STEP);
      }
    }
  }
  // The flights between blocks at floors of their own (a split level, `levelFlights`)
  for (const f of levelFlights(b, cut)) {
    const run = Math.hypot(f.top.x - f.foot.x, f.top.y - f.foot.y);
    const ux = (f.top.x - f.foot.x) / run, uy = (f.top.y - f.foot.y) / run;
    const tread = run / f.risers, rise = (f.z1 - f.z0) / f.risers, half = f.width / 2;
    for (let k = 0; k < f.risers; k++) {
      const a = { x: f.foot.x + ux * tread * k, y: f.foot.y + uy * tread * k };
      const c = { x: f.foot.x + ux * tread * (k + 1), y: f.foot.y + uy * tread * (k + 1) };
      const x0 = Math.min(a.x, c.x) - Math.abs(uy) * half, x1 = Math.max(a.x, c.x) + Math.abs(uy) * half;
      const y0 = Math.min(a.y, c.y) - Math.abs(ux) * half, y1 = Math.max(a.y, c.y) + Math.abs(ux) * half;
      e.box(x0, y0, x1, y1, floor + f.z0, floor + f.z0 + rise * (k + 1), STEP);
    }
  }
  // The rooms: their walls, with doorways, and what is in them.
  const inside = interiorAt(b, cut);
  const wallRise = Math.min(levelHeight(b, cut) - m(0.4), m(2.7));
  // Walls across the camera's line of sight come down to a skirting, as in The Sims
  const view = b.cutView;
  const viewLocal = view ? { x: view.x * Math.cos(b.rotation) + view.y * Math.sin(b.rotation), y: -view.x * Math.sin(b.rotation) + view.y * Math.cos(b.rotation) } : null;
  for (const p of inside.partitions) {
    const t = m(0.06);
    const len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0) || 1;
    // The wall's normal against the view: near 1 means it faces the camera.
    const facing = viewLocal ? Math.abs((-(p.y1 - p.y0) / len) * viewLocal.x + ((p.x1 - p.x0) / len) * viewLocal.y) : 0;
    const z = zAt((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2);
    const top = facing > 0.6 ? z + m(0.9) : z + wallRise;
    e.box(Math.min(p.x0, p.x1) - t, Math.min(p.y0, p.y1) - t, Math.max(p.x0, p.x1) + t, Math.max(p.y0, p.y1) + t, z, top, PARTITION);
  }
  // A ceiling light hangs from the ceiling; everything else stands on the floor.
  for (const f of inside.furniture) {
    const z = zAt(f.x, f.y);
    placeFurniture(e, f, f.kind === 'ceilingLamp' ? z + levelHeight(b, cut) - m(0.06) - f.h : z);
  }
}

/** One piece of furniture, as an instance of its model */
function placeFurniture(e: Emitter, f: Furniture, floorZ: number): void {
  const [w, d, h] = FURNITURE_SIZE[f.kind];
  const p = e.L(f.x, f.y, floorZ + 0.05);
  const front = e.N(Math.sin(f.angle), -Math.cos(f.angle));
  const list = (e.furniture[f.kind] ??= []);
  list.push({ x: p[0], y: p[1], z: p[2], yaw: Math.atan2(front[0], -front[1]), sx: f.w / w, sy: f.h / h, sz: f.d / d });
}

const PARTITION = paint({ finish: 'plaster', colour: 0xece6da });
/** How much light a window reveal keeps: it sits in the wall's own shadow. */
const REVEAL_SHADE = 0.68;

const shaded = (c: Paint, k: number): Paint => ({ rgb: [c.rgb[0] * k, c.rgb[1] * k, c.rgb[2] * k], finish: c.finish });

/** Walls that take a rain streak: render, stucco, concrete and stone (not glass, tile, brick or metal). */
const STREAKED: ReadonlySet<Finish> = new Set<Finish>(['plaster', 'stucco', 'concrete', 'stone']);
/** The rain streak under a sill: water off the sill runs down the wall and leaves a darker wash fading downwards */
function emitStreak(e: Emitter, f: BayFace, bay: FacadeBay, am: number, w: number, sill: number, wall: Paint): void {
  if (!STREAKED.has(wall.finish) || sill < m(0.5)) return;
  const h = bayHash(bay);
  if (h % 3 === 0) return;
  const reach = Math.min(sill - m(0.05), m(0.7 + (h % 7) * 0.12));
  const half = w * (0.32 + (h % 5) * 0.03);
  const dark = 1 - (0.07 + 0.12 * e.shell.decay);
  const out = -m(0.012);
  e.shell.face([e.P(f, am - half, sill - reach, out), e.P(f, am + half, sill - reach, out), e.P(f, am + half, sill - m(0.02), out), e.P(f, am - half, sill - m(0.02), out)],
    e.N(f.nx, f.ny), wall, [1, 1, dark, dark]);
}

/** A bay of the far level: its wall's paint, its opening (none: a plain wall) and the foot its grime is measured from. */
interface FarBay {
  readonly bay: FacadeBay;
  readonly wall: Paint;
  readonly opening: Opening | null;
  readonly ground: number;
}


/** The far level's kind of a bay's opening: which panes, doors or shutters `emitBay` puts in it. */
function facadeKind(c: BayComponent): number {
  switch (c) {
    // Dark one bay in four of twenty, a roller shutter part way down in four (`bayHash`).
    case 'window': return FACADE_KIND.window;
    case 'sashWindow': case 'wideWindow': case 'balcony': case 'shopfront': return FACADE_KIND.clear;
    case 'loggia': case 'shutteredWindow': case 'gourmet': return FACADE_KIND.darkQuarter;
    case 'brise': case 'frenchWindow': case 'bayWindow': case 'ribbon': return FACADE_KIND.darkFifth;
    case 'door': case 'doubleDoor': return FACADE_KIND.door;
    case 'loadingDoor': case 'garageDoor': return FACADE_KIND.shutterDoor;
    default: return FACADE_KIND.none;
  }
}

/** Two lengths the same to the emitter's sums. */
const sameLength = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** A run of bays the far level lays as one quad: its first bay, how many along, how many storeys up. */
interface FarRun {
  readonly first: FarBay;
  readonly key: string;
  readonly kind: number;
  bays: number;
  storeys: number;
}

/** DO NOT lay the far level bay by bay: a storey of like bays is one quad, like storeys over the base one quad, the windows drawn by the shader (`facadeLevel.ts`) */
function emitFacadeRuns(e: Emitter, volumes: ReadonlyMap<number, Volume>, floor: number, list: readonly FarBay[], trim: Paint): void {
  // Bays alike: same block, side, plane, bay and storey size, paint, opening and grime foot.
  const keyOf = (x: FarBay, kind: number): string => {
    const { bay, wall, opening: o } = x;
    const open = o && kind !== FACADE_KIND.none ? `${o.a0.toFixed(4)},${o.a1.toFixed(4)},${o.h0.toFixed(4)},${o.h1.toFixed(4)}` : '-';
    return `${bay.volume}|${bay.side}|${bay.push.toFixed(4)}|${bay.width.toFixed(4)}|${bay.height.toFixed(4)}|${wall.finish}|${wall.rgb.join(',')}|${kind}|${open}|${x.ground.toFixed(4)}`;
  };
  // Along each storey: bays side by side, each the next index, make one run.
  const sorted = [...list].sort((a, b) => a.bay.volume - b.bay.volume || a.bay.side - b.bay.side || a.bay.level - b.bay.level || a.bay.push - b.bay.push || a.bay.start - b.bay.start);
  const rows: FarRun[] = [];
  let last: FarRun | null = null;
  for (const x of sorted) {
    const kind = x.opening ? facadeKind(x.bay.component) : FACADE_KIND.none;
    const key = keyOf(x, kind);
    const at = last ? last.first.bay : null;
    if (last && at && last.key === key && at.level === x.bay.level && x.bay.index === at.index + last.bays
      && sameLength(at.start + last.bays * at.width, x.bay.start)) {
      last.bays++;
      continue;
    }
    last = { first: x, key, kind, bays: 1, storeys: 1 };
    rows.push(last);
  }
  // Up the facade: a run over another alike, the same bays, one storey higher, joins it, but never over the base storey the grime darkens.
  const runs: FarRun[] = [];
  const open = new Map<string, FarRun>();
  rows.sort((a, b) => a.first.bay.level - b.first.bay.level);
  for (const row of rows) {
    const bay = row.first.bay;
    const slot = `${row.key}|${bay.index}|${row.bays}|${bay.start.toFixed(4)}`;
    const below = open.get(slot);
    if (below) {
      const base = below.first.bay;
      const clear = floor + base.z - below.first.ground >= GRIME_REACH;
      if (clear && bay.level === base.level + below.storeys && sameLength(base.z + below.storeys * base.height, bay.z)) {
        below.storeys++;
        continue;
      }
    }
    open.set(slot, row);
    runs.push(row);
  }
  const shell = e.shell;
  const tc = trimColour(trim);
  const ground = shell.ground;
  for (const run of runs) {
    const { bay, wall, opening: o, ground: foot } = run.first;
    const v = volumes.get(bay.volume) as Volume;
    const W = bay.width, H = bay.height;
    const f: BayFace = { ...sideFrame(v, bay.side, bay.start, bay.push), z0: floor + bay.z, W: W * run.bays, H: H * run.storeys };
    const along = e.N(f.tx, f.ty);
    const u0 = bay.index, u1 = bay.index + run.bays, v0 = bay.level, v1 = bay.level + run.storeys;
    shell.ground = foot;
    shell.stamp = {
      kind: run.kind, volume: bay.volume, side: bay.side, tx: along[0], ty: along[1], W, H,
      opening: o && run.kind !== FACADE_KIND.none ? [o.a0 / W, o.a1 / W, o.h0 / H, o.h1 / H] : [0, 0, 0, 0],
      trim: [tc.r, tc.g, tc.b],
      uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      office: e.building.use === 'commercial' || e.building.use === 'industrial',
    };
    e.rect(f, 0, f.W, 0, f.H, 0, e.N(f.nx, f.ny), wall);
    shell.stamp = null;
  }
  shell.ground = ground;
}

/** A stable number per bay, for choosing among window variants. */
function bayHash(bay: FacadeBay): number {
  let h = Math.imul(bay.volume + 1, 0x27d4eb2d) ^ Math.imul(bay.level + 7, 0x165667b1) ^ Math.imul(bay.side + 3, 0x3c6ef372) ^ Math.imul(bay.index + 11, 0x85ebca6b);
  h ^= Math.imul(Math.round(bay.x * 7), 0x2c1b3c6d) ^ Math.imul(Math.round(bay.y * 7), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** The height of a door canopy's slab (its centre, `half` its thickness) */
function canopyAt(head: number, H: number, half: number, over: number): number {
  return Math.min(head + over, H - m(0.42) - half);
}

function emitBay(
  e: Emitter,
  f: BayFace,
  bay: FacadeBay,
  wall: Paint,
  trim: Paint,
  awning: Color,
  /** What the bays either side of it hold, along the same storey (none past the side's ends). */
  left: BayComponent | undefined,
  right: BayComponent | undefined,
  /** An entrance whose flight is set into the building: the opening becomes a porch this deep. */
  recess = 0,
  geometry?: FacadeGeometry,
): void {
  const out = e.N(f.nx, f.ny);
  const along = e.N(f.tx, f.ty);
  const back: V3 = [-along[0], -along[1], 0];
  const { W, H } = f;

  if (bay.component === 'pillar') {
    // An arcade: the wall steps back, a column stands on the facade line.
    e.rect(f, 0, W, 0, H, ARCADE, out, wall);
    e.strip(f, 0, W, H, 0, ARCADE, [0, 0, -1], trim);
    e.strip(f, 0, W, 0.02, 0, ARCADE, [0, 0, 1], ARCADE_FLOOR);
    if (left !== 'pillar') e.jamb(f, 0, 0, H, 0, ARCADE, along, wall);
    if (right !== 'pillar') e.jamb(f, W, 0, H, 0, ARCADE, back, wall);
    const d = m(0.55);
    e.put('column', f, W / 2, H / 2, m(0.35), d, H, d);
    return;
  }

  const tc = trimColour(trim);
  const found = openingOf(bay.component, W, H, geometry);
  if (!found) {
    if (!e.flat) e.rect(f, 0, W, 0, H, 0, out, wall);
    return;
  }
  // A porch runs down to the floor and back to the door; its floor is the top of the flight, so it has no sill of its own.
  const o = recess > 0 ? { ...found, h0: 0, depth: recess } : found;
  // The wall around the hole, then the four reveals into it (a flattened bay's wall is its run's, `emitFacadeRuns`).
  if (!e.flat) {
    e.rect(f, 0, o.a0, 0, H, 0, out, wall);
    e.rect(f, o.a1, W, 0, H, 0, out, wall);
    e.rect(f, o.a0, o.a1, 0, o.h0, 0, out, wall);
    e.rect(f, o.a0, o.a1, o.h1, H, 0, out, wall);
    // The reveals are in the wall's shadow
    const reveal = shaded(recess > 0 ? wall : trim, REVEAL_SHADE);
    e.jamb(f, o.a0, o.h0, o.h1, 0, o.depth, along, reveal);
    e.jamb(f, o.a1, o.h0, o.h1, 0, o.depth, back, reveal);
    // A sill; at the floor, a threshold as high as the plinth's ledge
    if (recess <= 0) e.strip(f, o.a0, o.a1, o.h0 > 1e-6 ? o.h0 : PLINTH_RISE, 0, o.depth, [0, 0, 1], shaded(trim, 0.92));
    e.strip(f, o.a0, o.a1, o.h1, 0, o.depth, [0, 0, -1], shaded(reveal, 0.8));
  }

  const w = o.a1 - o.a0;
  const h = o.h1 - o.h0;
  const am = (o.a0 + o.a1) / 2;
  const hm = (o.h0 + o.h1) / 2;
  switch (bay.component) {
    case 'window':
    case 'sashWindow': {
      // No two rows alike: some rooms darker, some with the roller shutter part way down - picked from the bay, so stable.
      const pick = bay.component === 'sashWindow' ? 13 : bayHash(bay) % 20;
      e.put(pick < 5 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      // The shutter a little inside the frame's edges: as wide as it, its sides lay in the frame's own and fought it for depth.
      if (pick >= 9 && pick < 13) {
        const down = h * (0.25 + (pick - 9) * 0.15) - PART_INSET;
        e.put('shutter', f, am, o.h1 - PART_INSET - down / 2, o.depth - m(0.05), w - 2 * PART_INSET, down, m(0.04));
      }
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // The sill: out past the wall, with a drip.
      e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
      emitStreak(e, f, bay, am, w, o.h0 - m(0.06), wall);
      break;
    }
    case 'wideWindow':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      break;
    case 'balcony':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      e.put('concrete', f, W / 2, -m(0.09), -m(0.65), W - m(0.3), m(0.18), m(1.3));
      e.put('railing', f, W / 2, 0, 0, W - m(0.3), m(1.05), m(1.3), tc);
      break;
    case 'door':
      e.put('door', f, am, hm, o.depth + m(0.03), w, h, m(0.06));
      if (bay.level === 0) {
        // A canopy over the door: a slab with a fascia at its edge (a drip), and two brackets under it into the wall.
        const cz = canopyAt(o.h1, H, m(0.06), m(0.3));
        e.put('concrete', f, am, cz, -m(0.45), w + m(0.7), m(0.12), m(0.9));
        e.put('concrete', f, am, cz - m(0.04), -m(0.88), w + m(0.7), m(0.2), m(0.05));
        // The brackets up to the slab's soffit, not into it
        for (const side of [-1, 1]) e.put('frame', f, am + side * (w / 2 + m(0.2)), cz - m(0.06) - m(0.15), -m(0.25), m(0.06), m(0.3), m(0.5), tc);
        emitPorchLight(e, f, W, am, w, o.h1);
      }
      break;
    case 'shopfront':
      e.put('glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      e.put('awning', f, W / 2, o.h1 + m(0.45), 0, W - m(0.2), m(0.75), m(1.3), awning);
      break;
    case 'loadingDoor':
    case 'garageDoor':
      e.put('shutter', f, am, hm, o.depth, w, h, m(0.1));
      break;
    case 'doubleDoor': {
      // Two leaves up to door height, and a fanlight over them in a tall opening; a canopy over the whole on the ground floor.
      const leafTop = Math.min(h, m(2.5));
      const leafMid = o.h0 + leafTop / 2;
      for (const side of [-1, 1]) {
        const cx = am + side * (w / 4);
        e.put('door', f, cx, leafMid, o.depth + m(0.03), w / 2 - m(0.04), leafTop, m(0.06));
        e.put('glassDark', f, cx, leafMid + leafTop * 0.12, o.depth - m(0.01), w / 2 - m(0.5), leafTop * 0.5, m(0.02));
      }
      if (h > leafTop + m(0.4)) {
        const fan = h - leafTop - m(0.12);
        e.put('glass', f, am, o.h0 + leafTop + m(0.12) + fan / 2, o.depth, w, fan, 1);
        e.put('frame', f, am, o.h0 + leafTop + m(0.12) + fan / 2, o.depth - m(0.03), w, fan, m(0.05), tc);
        e.put('frame', f, am, o.h0 + leafTop + m(0.06), o.depth - m(0.03), w, m(0.12), m(0.08), tc);
      }
      if (bay.level === 0) {
        const cz = canopyAt(o.h1, H, m(0.07), m(0.3));
        e.put('concrete', f, am, cz, -m(0.55), w + m(1), m(0.14), m(1.1));
        e.put('concrete', f, am, cz - m(0.05), -m(1.08), w + m(1), m(0.24), m(0.05));
        emitPorchLight(e, f, W, am, w, o.h1);
      }
      break;
    }
    case 'loggia': {
      // The glazed wall at the back of the loggia, and a glass parapet on the facade line.
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth - m(0.02), w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.05), w, h, m(0.06), tc);
      e.put('glassRail', f, am, o.h0, -m(0.02), w, m(1.05), 1);
      e.put('fin', f, am, o.h0 + m(1.06), -m(0.02), w, m(0.05), m(0.06), tc);
      break;
    }
    case 'brise': {
      e.put(bayHash(bay) % 5 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      // Vertical fins the storey's height, standing out of the wall: the brise-soleil of the Brazilian modern block
      const fd = m(0.6);
      e.put('brise', f, W / 2, H / 2, -fd / 2, W, H, fd, tc);
      break;
    }
    case 'shutteredWindow': {
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // A moulded surround in the trim, then the louvred leaves folded back on the wall either side, in the shutter paint
      const band = m(0.14);
      e.put('fin', f, am, o.h1 + band / 2, -m(0.03), w + band * 2, band, m(0.06), tc);
      for (const side of [-1, 1]) e.put('fin', f, am + side * (w / 2 + band / 2), hm, -m(0.03), band, h, m(0.06), tc);
      if (o.a0 >= w / 2 + band) for (const side of [-1, 1]) e.put('louvre', f, am + side * (w * 0.75 + band), hm, -m(0.05), w / 2, h, m(0.04), shutterColour(wall, trim));
      e.put('concrete', f, am, o.h0 - m(0.04), (o.depth - m(0.1)) / 2, w + band * 2 + m(0.1), m(0.08), o.depth + m(0.1));
      emitStreak(e, f, bay, am, w, o.h0 - m(0.08), wall);
      break;
    }
    case 'gourmet': {
      // Sliding glass the bay's width, and the deep balcony: its slab, a glass parapet along its front edge.
      e.put(bayHash(bay) % 4 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.05), tc);
      const slab = slabColour(wall);
      // Where the run of balconies ends, the side wall that carries the slabs storey on storey and closes the balcony
      const closedLeft = left !== 'gourmet', closedRight = right !== 'gourmet';
      const r0 = closedLeft ? CHEEK_IN + GOURMET_CHEEK / 2 : 0, r1 = closedRight ? W - CHEEK_IN - GOURMET_CHEEK / 2 : W;
      e.put('fin', f, W / 2, -m(0.12), -GOURMET_OUT / 2, W, m(0.24), GOURMET_OUT, slab);
      // The slab's edge beam, a drip under its front: the slab reads as a floor of the building carried out, not a tray.
      e.put('fin', f, W / 2, -m(0.2), -GOURMET_OUT + m(0.06), W, m(0.18), m(0.16), slab);
      e.put('glassRail', f, (r0 + r1) / 2, 0, -GOURMET_OUT + m(0.04), r1 - r0, m(1.05), 1);
      // The rail's metal cap along the top of the glass, in the frames' colour.
      e.put('fin', f, (r0 + r1) / 2, m(1.06), -GOURMET_OUT + m(0.04), r1 - r0, m(0.05), m(0.06), tc);
      for (const [u, closed] of [[CHEEK_IN + GOURMET_CHEEK / 2, closedLeft], [W - CHEEK_IN - GOURMET_CHEEK / 2, closedRight]] as const) {
        // A storey high from under the slab, so the cheeks of the storeys stack into one wall
        if (closed) e.put('fin', f, u, H / 2 - CHEEK_FOOT, (CHEEK_BURY - GOURMET_OUT - m(0.05)) / 2, GOURMET_CHEEK, H, GOURMET_OUT + m(0.05) + CHEEK_BURY, slab);
      }
      if (!closedRight) e.put('frame', f, W, m(0.55), -GOURMET_OUT / 2 - m(0.1), m(0.06), m(1.1), GOURMET_OUT - m(0.2), tc);
      break;
    }
    case 'frenchWindow':
    case 'bayWindow':
    case 'ribbon': {
      e.put(bayHash(bay) % 5 === 0 ? 'glassDark' : 'glass', f, am, hm, o.depth, w, h, 1);
      e.put('frame', f, am, hm, o.depth - m(0.03), w, h, m(0.06), tc);
      // A transom across a tall pane, and a sill under the raised ones.
      if (h > m(2.2)) e.put('frame', f, am, o.h0 + h * 0.72, o.depth - m(0.03), w, m(0.08), m(0.07), tc);
      if (o.h0 > m(0.3)) {
        e.put('concrete', f, am, o.h0 - m(0.03), (o.depth - m(0.07)) / 2, w + m(0.14), m(0.06), o.depth + m(0.07));
        emitStreak(e, f, bay, am, w, o.h0 - m(0.06), wall);
      }
      break;
    }
    default:
      break;
  }
  // What hangs on the bay and stands on its balcony (`facadeProps.ts`), its own by the bay.
  const b = e.building;
  for (const p of facadeProps(bay.component, bay.level, b.use, b.decay ?? 0, bayHash(bay), W, o)) {
    e.put(p.kind, f, p.a, p.h, -p.out, p.sx, p.sy, p.sz, new Color(p.colour), p.turn);
  }
}

/** A ground volume's plinth, from `bottom` to `floor`, PLINTH_GROW proud of the walls */
function emitPlinth(
  e: Emitter,
  b: Building,
  v: Volume,
  bottom: number,
  floor: number,
  c: Paint,
  notches: ReadonlyMap<FaceId, readonly { a0: number; a1: number; recess: number }[]>,
): void {
  const g = PLINTH_GROW;
  // Only along the outside: where another block of the ground stands against a side, the plinth
  const coveredOf = (side: FaceId, base: number): [number, number][] =>
    coveredSpans(b, v, side, 0).map(([a0, a1]) => [base + a0, base + a1] as [number, number]);
  if (v.outline) {
    for (const side of volumeSides(v)) {
      const f = edgeFrame(v, side);
      const covered = coveredOf(side, 0);
      const at = (a: number, depth: number, z: number): V3 => e.L(f.x + f.tx * a - f.nx * depth, f.y + f.ty * a - f.ny * depth, z);
      const n = e.N(f.nx, f.ny);
      const t = e.N(f.tx, f.ty);
      const cuts = [...(notches.get(side) ?? [])].sort((a, b) => a.a0 - b.a0);
      let from = 0;
      const wallTo = (to: number): void => {
        if (to - from < 1e-4) return;
        for (const [p0, p1] of exposedParts(covered, from, to)) {
          e.shell.face([at(p0, -g, bottom), at(p1, -g, bottom), at(p1, -g, floor), at(p0, -g, floor)], n, c);
          e.shell.face([at(p0, -g, floor), at(p1, -g, floor), at(p1, g, floor), at(p0, g, floor)], [0, 0, 1], c);
        }
      };
      for (const cut of cuts) {
        wallTo(cut.a0);
        const depth = g + cut.recess;
        e.shell.face([at(cut.a0, -g, bottom), at(cut.a0, depth, bottom), at(cut.a0, depth, floor), at(cut.a0, -g, floor)], t, c);
        e.shell.face([at(cut.a1, depth, bottom), at(cut.a1, -g, bottom), at(cut.a1, -g, floor), at(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
        from = cut.a1;
      }
      wallTo(f.length);
    }
    return;
  }
  const x0 = v.x - g;
  const y0 = v.y - g;
  const x1 = v.x + v.w + g;
  const y1 = v.y + v.d + g;
  for (const side of volumeSides(v)) {
    // The side as a line in the plan: where it runs along its axis and where it stands across it.
    const alongX = side === 0 || side === 2;
    const lo = alongX ? x0 : y0;
    const hi = alongX ? x1 : y1;
    const at = side === 0 ? y0 : side === 1 ? x1 : side === 2 ? y1 : x0;
    const inward = side === 0 || side === 3 ? 1 : -1;
    const point = (a: number, depth: number, z: number): V3 =>
      alongX ? e.L(a, at + inward * depth, z) : e.L(at + inward * depth, a, z);
    const edge = edgeFrame(v, side);
    const n = { x: edge.nx, y: edge.ny };
    const out = e.N(n.x, n.y);
    const cuts = [...(notches.get(side) ?? [])].sort((p, q) => p.a0 - q.a0);
    // A side runs along its axis from the block's corner (`sideStart`).
    const covered = coveredOf(side, alongX ? v.x : v.y);
    let from = lo;
    const wallTo = (to: number): void => {
      if (to - from < 1e-4) return;
      for (const [p0, p1] of exposedParts(covered, from, to)) {
        e.shell.face([point(p0, 0, bottom), point(p1, 0, bottom), point(p1, 0, floor), point(p0, 0, floor)], out, c);
        e.shell.face([point(p0, 0, floor), point(p1, 0, floor), point(p1, g, floor), point(p0, g, floor)], [0, 0, 1], c);
      }
    };
    for (const cut of cuts) {
      wallTo(cut.a0);
      // The notch's cheeks, facing into it; the flight fills its floor and back.
      const depth = g + cut.recess;
      const t = alongX ? e.N(1, 0) : e.N(0, 1);
      e.shell.face([point(cut.a0, 0, bottom), point(cut.a0, depth, bottom), point(cut.a0, depth, floor), point(cut.a0, 0, floor)], t, c);
      e.shell.face([point(cut.a1, depth, bottom), point(cut.a1, 0, bottom), point(cut.a1, 0, floor), point(cut.a1, depth, floor)], [-t[0], -t[1], 0], c);
      from = cut.a1;
    }
    wallTo(hi);
  }
}

/** A flight set into the building: from the plinth's face up to the door at `recess` behind the facade */
function emitRecessedFlight(
  e: Emitter,
  face: BayFace,
  a0: number,
  a1: number,
  entrance: Entrance,
  floor: number,
  bottom: number,
  riser: number,
  c: Paint,
): void {
  const n = e.N(face.nx, face.ny);
  const start = -PLINTH_GROW;
  if (entrance.threshold > PLINTH_GROW) {
    // The slab over the verge, from the paving to the foot of the flight.
    const top = entrance.ground - floor;
    const out = -entrance.threshold;
    const t = e.N(face.tx, face.ty);
    e.rect(face, a0, a1, bottom - floor, top, out, n, c);
    e.shell.face([e.P(face, a0, top, out), e.P(face, a1, top, out), e.P(face, a1, top, start), e.P(face, a0, top, start)], [0, 0, 1], c);
    e.shell.face([e.P(face, a1, bottom - floor, out), e.P(face, a1, bottom - floor, start), e.P(face, a1, top, start), e.P(face, a1, top, out)], t, c);
    e.shell.face([e.P(face, a0, bottom - floor, start), e.P(face, a0, bottom - floor, out), e.P(face, a0, top, out), e.P(face, a0, top, start)], [-t[0], -t[1], 0], c);
  }
  const tread = (entrance.recess - start) / (entrance.steps + 1);
  for (let k = 0; k < entrance.steps; k++) {
    const top = entrance.ground + (k + 1) * riser - floor;
    const d0 = start + k * tread;
    // Each block runs to the door, so only its riser and its tread show.
    e.rect(face, a0, a1, bottom - floor, top, d0, n, c);
    e.shell.face([e.P(face, a0, top, d0), e.P(face, a1, top, d0), e.P(face, a1, top, entrance.recess), e.P(face, a0, top, entrance.recess)], [0, 0, 1], c);
  }
}

/** The frame of a relief: its two cheeks and its head and sill, between the side's plane and the region's */
function emitRelief(e: Emitter, b: Building, v: Volume, r: Relief, floor: number, wall: Paint, trim: Paint): void {
  const count = baysOn(b, v, r.side);
  const top = v.storeys.length - 1;
  if (r.depth === 0 || r.bay0 > count - 1 || r.storey0 > top) return;
  const w = bayWidth(b, v, r.side);
  const a0 = Math.max(0, r.bay0) * w;
  const a1 = (Math.min(count - 1, r.bay1) + 1) * w;
  const z0 = floor + volumeElevation(b, v, v.base + Math.max(0, r.storey0));
  const z1 = floor + volumeElevation(b, v, v.base + Math.min(top, r.storey1) + 1);
  const s = sideStart(v, r.side);
  const f = edgeFrame(v, r.side);
  const n = { x: f.nx, y: f.ny };
  const d = r.depth;
  const P = (a: number, z: number, out: number): V3 => e.L(s.x + s.tx * a + n.x * out, s.y + s.ty * a + n.y * out, z);
  const t = e.N(s.tx, s.ty);
  const into: V3 = [-t[0], -t[1], 0];
  const out = d > 0;
  // Cheeks: facing away from the region on a projection, into it on a recess.
  e.shell.face([P(a0, z0, 0), P(a0, z0, d), P(a0, z1, d), P(a0, z1, 0)], out ? into : t, wall);
  e.shell.face([P(a1, z0, d), P(a1, z0, 0), P(a1, z1, 0), P(a1, z1, d)], out ? t : into, wall);
  e.shell.face([P(a0, z1, 0), P(a1, z1, 0), P(a1, z1, d), P(a0, z1, d)], [0, 0, out ? 1 : -1], trim);
  e.shell.face([P(a0, z0, 0), P(a1, z0, 0), P(a1, z0, d), P(a0, z0, d)], [0, 0, out ? -1 : 1], trim);
}

/** What stands on a flat roof: drains in two opposite corners */
function emitRoofPlant(e: Emitter, b: Building, v: Volume, z: number, trim: Paint): void {
  if (v.roofDetails?.length) return;
  // Drains in two opposite corners, where the roof's fall takes the water.
  if (v.outline) return;
  for (const [dx, dy] of [[m(0.7), m(0.7)], [v.w - m(0.7), v.d - m(0.7)]] as const) {
    const x = v.x + dx;
    const y = v.y + dy;
    e.box(x - m(0.18), y - m(0.18), x + m(0.18), y + m(0.18), z, z + 0.02, DRAIN);
  }
  const items = roofPlantOf(b, v);
  for (const it of items) {
    const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2, w = it.x1 - it.x0, d = it.y1 - it.y0;
    switch (it.kind) {
      case 'tank': {
        // The rooftop water tank (caixa d'água): a round fibreglass tank on a plinth, tapering in at the top, its lid.
        const paint = TANK_PAINTS[it.variant % TANK_PAINTS.length]!;
        const r = Math.min(w, d) / 2;
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + m(0.3), ROOF_PLANT);
        e.cylinder(cx, cy, r * 0.84, z + m(0.3), z + it.h - m(0.3), paint);
        e.cylinder(cx, cy, r * 0.94, z + it.h - m(0.3), z + it.h - m(0.05), paint, shaded(paint, 0.82));
        e.cylinder(cx, cy, r * 0.4, z + it.h - m(0.05), z + it.h + m(0.05), shaded(paint, 0.75));
        break;
      }
      case 'tankBox':
        // A concrete water tank on a tall block, its lid and a ladder up its side.
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, trim, ROOF_PLANT);
        e.box(it.x0 + m(0.3), it.y0 + m(0.3), it.x0 + m(1.1), it.y0 + m(1.1), z + it.h, z + it.h + m(0.12), DRAIN);
        e.box(it.x1 - m(0.05), cy - m(0.25), it.x1 + m(0.05), cy + m(0.25), z, z + it.h + m(0.9), DRAIN);
        break;
      case 'hatch':
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, ROOF_PLANT);
        break;
      case 'condenser':
        e.box(it.x0, it.y0, it.x1, it.y1, z + m(0.15), z + it.h, CONDENSER);
        e.box(cx - m(0.28), cy - m(0.28), cx + m(0.28), cy + m(0.28), z + it.h, z + it.h + m(0.02), DRAIN);
        break;
      case 'airHandler': {
        // A rooftop air handler: a long metal casing, its fans on top.
        e.box(it.x0, it.y0, it.x1, it.y1, z + m(0.2), z + it.h, CONDENSER);
        const along = w >= d;
        for (const k of [0.25, 0.75]) {
          const fx = along ? it.x0 + w * k : cx, fy = along ? cy : it.y0 + d * k;
          e.cylinder(fx, fy, Math.min(w, d) * 0.32, z + it.h, z + it.h + m(0.12), DRAIN);
        }
        break;
      }
      case 'solar': {
        // Rows of panels tilted to the sun on their frames, filling the array's ground.
        const rows = Math.max(1, Math.floor(d / m(1.7)));
        for (let r = 0; r < rows; r++) {
          const py = it.y0 + r * (d / rows);
          for (let px = it.x0; px + m(1.05) <= it.x1 + 1e-6; px += m(1.15)) {
            e.box(px, py, px + m(1.05), py + Math.min(m(1.6), d / rows - m(0.1)), z + m(0.25), z + m(0.32), SOLAR, SOLAR);
            e.box(px + m(0.45), py + m(1.2), px + m(0.6), py + m(1.35), z, z + m(0.25), DRAIN);
          }
        }
        break;
      }
      case 'mast':
        e.box(cx - m(0.04), cy - m(0.04), cx + m(0.04), cy + m(0.04), z, z + it.h, DRAIN);
        e.box(cx - m(0.6), cy - m(0.02), cx + m(0.6), cy + m(0.02), z + it.h - m(0.4), z + it.h - m(0.36), DRAIN);
        if (it.variant % 2 === 1) e.box(cx - m(0.02), cy - m(0.45), cx + m(0.02), cy + m(0.45), z + it.h - m(0.9), z + it.h - m(0.86), DRAIN);
        break;
      case 'dish':
        // Its post thinner than the dish's plate, never in the plate's sides.
        e.box(cx - m(0.04), cy - m(0.04), cx + m(0.04), cy + m(0.04), z, z + m(0.7), DRAIN);
        e.box(cx - m(0.4), cy - m(0.05), cx + m(0.4), cy + m(0.05), z + m(0.5), z + it.h, it.variant % 2 ? DRAIN : CONDENSER);
        break;
      case 'skylight':
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, ROOF_PLANT, SKYLIGHT);
        break;
      case 'vent':
        e.cylinder(cx, cy, Math.min(w, d) * 0.4, z, z + it.h - m(0.15), CONDENSER);
        e.cylinder(cx, cy, Math.min(w, d) * 0.5, z + it.h - m(0.15), z + it.h, DRAIN);
        break;
      case 'liftRoom':
        // A lift's machine room, with its door.
        e.box(it.x0, it.y0, it.x1, it.y1, z, z + it.h, trim, ROOF_PLANT);
        e.box(cx - m(0.45), it.y0 - m(0.04), cx + m(0.45), it.y0, z + m(0.05), z + m(2.1), DOOR_PAINT);
        break;
      case 'chimney':
        e.cylinder(cx, cy, Math.min(w, d) * 0.45, z, z + it.h, CHIMNEY, DRAIN);
        break;
    }
  }
}

/** Water tanks: the blue fibreglass of most roofs, the grey and the white of others, a sand-coloured one. */
const TANK_PAINTS: readonly Paint[] = TANK_COLOURS.map((colour) => paint({ finish: 'plaster', colour }));
const CHIMNEY: Paint = paint({ finish: 'brick', colour: ROOF_COLOURS.chimney });

const DRAIN: Paint = paint({ finish: 'metal', colour: 0x2d3033 });
const SOLAR: Paint = paint({ finish: 'glass', colour: ROOF_COLOURS.solar });
const SKYLIGHT: Paint = paint({ finish: 'glass', colour: ROOF_COLOURS.skylight });
const DECK: Paint = paint({ finish: 'wood', colour: 0x9a7650 });
const POT: Paint = paint({ finish: 'ceramic', colour: 0xa8573a });
const POT_SOIL: Paint = paint({ finish: 'plaster', colour: 0x3a2a1d });
const PARASOL: Paint = paint({ finish: 'plaster', colour: ROOF_COLOURS.parasol });

/** A roof terrace that is used (the player's order of 2026-10-05) */
function emitTerrace(e: Emitter, b: Building, v: Volume, z: number, trim: Paint): void {
  const deck = terraceDeck(b, v);
  if (!deck) return;
  const rnd = (k: number): number => terraceSeed(b, v, k);
  // The deck, a part of the terrace.
  const { x0: dx0, x1: dx1, y0: dy0, y1: dy1 } = deck;
  e.box(dx0, dy0, dx1, dy1, z, z + m(0.06), DECK);
  // Terracotta pots along the edges, dark soil in them, at a spacing of its own.
  const potStep = m(1.8 + 1.6 * rnd(5));
  for (let x = v.x + m(0.7); rnd(6) < 0.8 && x < v.x + v.w - m(0.6); x += potStep) {
    for (const y of [v.y + m(0.7), v.y + v.d - m(0.7)]) {
      e.cylinder(x, y, m(0.28), z, z + m(0.5), POT, POT_SOIL, 10);
    }
  }
  // Tables under parasols.
  for (const { x: tx, y: ty } of terraceParasols(b, v)) {
    e.box(tx - m(0.4), ty - m(0.4), tx + m(0.4), ty + m(0.4), z + m(0.7), z + m(0.75), trim);
    e.box(tx - m(0.04), ty - m(0.04), tx + m(0.04), ty + m(0.04), z, z + PARASOL_LOW, DRAIN);
    e.box(tx - PARASOL_HALF, ty - PARASOL_HALF, tx + PARASOL_HALF, ty + PARASOL_HALF, z + PARASOL_LOW, z + PARASOL_HIGH, PARASOL);
    for (const s of [-1, 1]) e.box(tx + s * m(0.7) - m(0.2), ty - m(0.2), tx + s * m(0.7) + m(0.2), ty + m(0.2), z, z + m(0.45), trim);
  }
  // Loungers on the far side, a pergola of beams over them.
  const lx = Math.min(v.x + v.w - m(1.5), dx1 + m(1.2));
  if (rnd(8) < 0.6) for (let y = dy0 + m(0.4); y + m(0.7) < dy1; y += m(1.2)) e.box(lx - m(0.9), y, lx + m(0.9), y + m(0.65), z, z + m(0.35), PARASOL);
  // The pergola: posts every 2.4 m on two lines, a beam along each line on the posts
  const span = dy1 - dy0;
  const bays = Math.max(1, Math.round(span / m(2.4)));
  const pergola = rnd(9) < 0.45;
  for (const px of pergola ? [lx - m(1.2), lx + m(1.2)] : []) {
    for (let k = 0; k <= bays; k++) {
      const py = dy0 + (span * k) / bays;
      e.box(px - m(0.07), py - m(0.07), px + m(0.07), py + m(0.07), z, z + m(2.4), DECK);
    }
    e.box(px - m(0.06), dy0 - m(0.1), px + m(0.06), dy1 + m(0.1), z + m(2.25), z + m(2.4), DECK);
  }
  if (pergola) for (let y = dy0; y <= dy1; y += m(0.6)) e.box(lx - m(1.45), y - m(0.04), lx + m(1.45), y + m(0.04), z + m(2.4), z + m(2.5), DECK);
  // The caixa d'agua, of one of the colours they come in, on most terraces.
  if (rnd(10) < 0.65) {
    const tank = TANK_PAINTS[Math.floor(rnd(11) * TANK_PAINTS.length)]!;
    const tx = v.x + v.w - m(1.4), ty = v.y + m(1.4);
    e.cylinder(tx, ty, m(0.7), z, z + m(0.95), tank);
    e.cylinder(tx, ty, m(0.78), z + m(0.95), z + m(1.15), tank, shaded(tank, 0.82));
  }
}
const CONDENSER: Paint = paint({ finish: 'metal', colour: ROOF_COLOURS.condenser });
const DOOR_PAINT: Paint = paint({ finish: 'metal', colour: 0x5c6468 });

/** Each lot surface in its finish, in the colour the far view lays it in too (`massing.ts`). */
const LOT_PAINT: Readonly<Record<LotSurface, Paint>> = {
  grass: paint({ finish: 'concrete', colour: LOT_COLOURS.grass }),
  paving: paint({ finish: 'stone', colour: LOT_COLOURS.paving }),
  gravel: paint({ finish: 'concrete', colour: LOT_COLOURS.gravel }),
  sand: paint({ finish: 'plaster', colour: LOT_COLOURS.sand }),
  water: paint({ finish: 'glass', colour: LOT_COLOURS.water }),
  asphalt: paint({ finish: 'concrete', colour: LOT_COLOURS.asphalt }),
  concrete: paint({ finish: 'concrete', colour: LOT_COLOURS.concrete }),
  pavers: paint({ finish: 'brick', colour: LOT_COLOURS.pavers }),
  tiles: paint({ finish: 'ceramic', colour: LOT_COLOURS.tiles }),
};
const LOT_KERB = paint({ finish: 'stone', colour: 0xb3ada0 });
/** Layers at a lot's edge, so no two faces there share a plane (a paving's `COVER_INSET` in `shellParts.ts`, its program stands its sides in by it) */
const KERB_INSET = m(0.012);
const POOL_TILE = paint({ finish: 'ceramic', colour: 0x9fd0dc });
/** A pool's floor, under the water: pale blue plaster. */
const POOL_FLOOR = paint({ finish: 'plaster', colour: 0x8fd3e6 });
/** The coping round a pool's rim: white stone, a little proud of the deck. */
const POOL_COPING = paint({ finish: 'stone', colour: 0xeeebe2 });
/** Depth of the water under the coping. */
const POOL_WATER_DROP = m(0.12);

/** The open blocks of a building, laid on the ground */
/** The grid the terrain is drawn on, whose triangles a lawn's parts are seated over (`lawnGround.ts`). */
const LAWN_LATTICE = { cell: TERRAIN_CELL, half: TERRAIN_HALF } as const;

/** `entrances`: the building's ways in as its body's emission worked them out (`emitBuilding`): DO NOT work its foundation out again for the flights' feet. */
function emitLots(b: Building, lots: readonly Volume[], withParts: boolean, groundAt: GroundAt, shell: Shell,
  parts: Record<PartKind, Placement[]>, buildingFloor?: number, pavedAt?: PavedAt,
  onLot?: (el: BuildingElement) => boolean, entrances?: readonly Entrance[]): LotGround | undefined {
  if (lots.length === 0) return lotGroundOf(b, [], buildingFloor, false);
  const e = new Emitter(b, shell, parts);
  const at = (lx: number, ly: number): number => {
    const w = e.L(lx, ly, 0);
    return groundAt(w[0], w[1]);
  };
  let floor = -Infinity;
  for (const v of lots) {
    for (const p of localFootprint(v)) floor = Math.max(floor, at(p.x, p.y));
    floor = Math.max(floor, at(v.x + v.w / 2, v.y + v.d / 2));
  }
  // A building's own yard - its car park, its garden - meets its ground floor at the back and the street at the front
  const level = buildingFloor !== undefined ? buildingFloor : floor + m(0.12);
  const surfaces = lotSurfaces(b, level, pavedAt);
  // Where the doors' flights stand: a path laid to a door stops at the foot of its steps.
  const feet = buildingFloor !== undefined ? flightFeet(b, groundAt, pavedAt, buildingFloor, entrances) : [];
  let low = Infinity;
  for (const v of lots) for (const p of localFootprint(v)) low = Math.min(low, at(p.x, p.y));
  const heightOf = new Map<Volume, (lx: number, ly: number) => number>();
  for (const s of surfaces) {
    heightOf.set(s.volume, (lx, ly) => {
      const w = e.L(lx, ly, 0);
      return s.heightAt(w[0], w[1]);
    });
  }
  for (const v of lots) {
    const height = heightOf.get(v) ?? (() => level);
    // A lawn is the terrain itself, graded to the lot (`pads.ts`), and drawn with the terrain's grass: no plate, no kerb.
    if ((v.open ?? 'grass') === 'grass') continue;
    const water = v.open === 'water';
    // A pool: its floor down at the bottom, the water itself a separate glossy surface just under the coping (`water` part).
    const look = water ? POOL_FLOOR : LOT_PAINT[v.open ?? 'grass'] ?? LOT_KERB;
    const sink = water ? POOL_SINK : 0;
    if (water) {
      const cx = v.x + v.w / 2, cy = v.y + v.d / 2;
      const rim = height(cx, cy);
      const centre = e.L(cx, cy, 0);
      e.parts.water.push({
        x: centre[0], y: centre[1], z: rim - POOL_WATER_DROP - m(0.01),
        yaw: b.rotation, sx: v.w, sy: m(0.02), sz: v.d,
      });
      // The coping: a white stone band round the rim.
      const band = m(0.3), lift = m(0.04);
      const ring = [
        [v.x - band, v.y - band, v.x + v.w + band, v.y],
        [v.x - band, v.y + v.d, v.x + v.w + band, v.y + v.d + band],
        [v.x - band, v.y, v.x, v.y + v.d],
        [v.x + v.w, v.y, v.x + v.w + band, v.y + v.d],
      ] as const;
      for (const [qx0, qy0, qx1, qy1] of ring) {
        shell.face([e.L(qx0, qy0, rim + lift), e.L(qx1, qy0, rim + lift), e.L(qx1, qy1, rim + lift), e.L(qx0, qy1, rim + lift)], [0, 0, 1], POOL_COPING);
      }
    }
    if (v.outline) {
      // A shaped lot is laid level, at the height of its middle.
      const z = height(v.x + v.w / 2, v.y + v.d / 2) - sink;
      const ring = localFootprint(v);
      const flat = ring.flatMap((p) => [p.x, p.y]);
      const triangles = earcut(flat);
      for (let i = 0; i < triangles.length; i += 3) {
        const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map((k) => e.L(flat[2 * k]!, flat[2 * k + 1]!, z));
        shell.face(p as [V3, V3, V3], [0, 0, 1], look);
      }
    } else {
      // A grid fine enough to follow the street's fall.
      const nx = Math.max(1, Math.ceil(v.w / m(3))), ny = Math.max(1, Math.ceil(v.d / m(3)));
      const P = (i: number, j: number): V3 => {
        const lx = v.x + (v.w * i) / nx, ly = v.y + (v.d * j) / ny;
        return e.L(lx, ly, height(lx, ly) - sink);
      };
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          shell.face([P(i, j), P(i + 1, j), P(i + 1, j + 1)], [0, 0, 1], look);
          shell.face([P(i, j), P(i + 1, j + 1), P(i, j + 1)], [0, 0, 1], look);
        }
      }
    }
    // The kerb round it, down to the ground, so no edge stands in the air.
    const ring = localFootprint(v);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = (q.y - p.y) / len;
      const ny = -(q.x - p.x) / len;
      const tx = (q.x - p.x) / len, ty = (q.y - p.y) / len;
      const steps = Math.max(1, Math.ceil(len / m(3)));
      for (let k = 0; k < steps; k++) {
        const ax = p.x + ((q.x - p.x) * k) / steps, ay = p.y + ((q.y - p.y) * k) / steps;
        const bx = p.x + ((q.x - p.x) * (k + 1)) / steps, by = p.y + ((q.y - p.y) * (k + 1)) / steps;
        const za = height(ax, ay), zb = height(bx, by);
        const foot = Math.min(Math.min(za, zb) - m(0.3), Math.min(at(ax, ay), at(bx, by)) - m(0.15));
        if (sink > 0) {
          // A pool's or a pond's side, tiled, from the water up to the rim.
          shell.face([e.L(ax, ay, za), e.L(bx, by, zb), e.L(bx, by, zb - sink), e.L(ax, ay, za - sink)], e.N(-nx, -ny), POOL_TILE);
        } else {
          // Set in under the plate's edge (`KERB_INSET`), and cut short at the corners by as much
          const sa = k === 0 ? KERB_INSET : 0, sb = k === steps - 1 ? KERB_INSET : 0;
          const kax = ax - nx * KERB_INSET + tx * sa, kay = ay - ny * KERB_INSET + ty * sa;
          const kbx = bx - nx * KERB_INSET - tx * sb, kby = by - ny * KERB_INSET - ty * sb;
          shell.face([e.L(kax, kay, foot), e.L(kbx, kby, foot), e.L(kbx, kby, zb), e.L(kax, kay, za)], e.N(nx, ny), LOT_KERB);
        }
      }
    }
  }
  const loose = looseParts(b);
  // DO NOT take the first lot that holds it.
  const hostAt = (x: number, y: number): Volume | undefined => {
    let lawn: Volume | undefined;
    for (const v of lots) {
      if (x < v.x || x > v.x + v.w || y < v.y || y > v.y + v.d) continue;
      if ((v.open ?? 'grass') !== 'grass') return v;
      lawn ??= v;
    }
    return lawn;
  };
  const onLawn = (x: number, y: number): boolean => {
    const host = hostAt(x, y);
    return !host || ((host.open ?? 'grass') === 'grass' && host.terrace === undefined);
  };
  const groups = partGroups(b);
  const earthworks = new Set<number>();
  for (const el of b.elements ?? []) {
    const g = groups.get(el.id);
    if (g !== undefined && (el.kind === 'stair' || el.kind === 'ramp' || isRetainingStone(el.material))) earthworks.add(g);
  }
  const seats = new Map<number, { base: number; lowest: number }>();
  {
    const lowest = new Map<number, number>();
    // Only what stands on the land is seated on it
    const standing = new Set<number>();
    for (const el of b.elements ?? []) {
      const g = groups.get(el.id);
      if (g === undefined) continue;
      lowest.set(g, Math.min(lowest.get(g) ?? Infinity, el.z));
      if (onGround(el)) standing.add(g);
    }
    for (const el of b.elements ?? []) {
      const g = groups.get(el.id);
      if (g === undefined || !standing.has(g) || earthworks.has(g) || el.z > lowest.get(g)! + m(0.05)) continue;
      const [x0, y0, x1, y1] = elementRect(el);
      const points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]] as const;
      const lawn = points.filter(([px, py]) => onLawn(px, py));
      if (lawn.length === 0) continue;
      // All on the lawn: the highest the drawn ground rises anywhere under it, ridges of the terrain's triangles included
      const ground = lawn.length === points.length
        ? highestGroundUnder(points.slice(0, 4).map(([px, py]) => { const w = e.L(px, py, 0); return [w[0], w[1]] as const; }), groundAt, LAWN_LATTICE)
        : Math.max(...lawn.map(([px, py]) => at(px, py)));
      const seat = seats.get(g);
      if (!seat) seats.set(g, { base: ground, lowest: lowest.get(g)! });
      else seat.base = Math.max(seat.base, ground);
    }
  }
  for (const el of b.elements ?? []) {
    if ((!withParts && !onLot?.(el)) || loose?.has(el.id)) continue;
    const look = el.material ? paint(el.material) : elementPaint(b, el.kind);
    const group = groups.get(el.id);
    const seat = group === undefined ? undefined : seats.get(group);
    if (seat && onLawn(el.x, el.y)) {
      // Its height within the object kept; its lowest parts at the seat.
      const placed = { ...el, z: el.z - seat.lowest };
      for (const piece of placed.kind === 'pavement' ? clearOf(placed, feet) : [placed]) {
        emitElement(e, piece, seat.base, Math.min(low, seat.base) - m(0.3), look);
      }
      continue;
    }
    // A run on the land in steps, each on the lot's surface under it, or on the ground where no lot is laid
    for (const piece of followPieces(el).flatMap((p) => (p.kind === 'pavement' ? clearOf(p, feet) : [p]))) {
      const host = hostAt(piece.x, piece.y);
      // On a lawn the ground is the terrain as drawn (`pads.ts`), not the lot's plane
      const height = host && (host.open ?? 'grass') !== 'grass' ? heightOf.get(host) : undefined;
      // A part raised or lowered with a paving at a level of its own
      const base = height && host && !FOLLOWS_GROUND.has(piece.kind) ? host.ramp ?? host.terrace ?? 0 : 0;
      const z = height ? height(piece.x, piece.y) - base : FOLLOWS_GROUND.has(piece.kind) ? at(piece.x, piece.y) : level;
      emitElement(e, piece, z, Math.min(low, z) - m(0.3), look, height);
    }
  }
  return lotGroundOf(b, surfaces, level, true);
}

/** A building's lot ground made again from its recipe, as `emitLots` made it */
export function lotGroundAgain(b: Building, recipe: LotGroundRecipe, pavedAt?: PavedAt): LotGround | undefined {
  const resolved = resolveBlocks(b);
  const surfaces = recipe.lots && recipe.level !== undefined ? lotSurfaces(resolved, recipe.level, pavedAt) : [];
  return lotGroundOf(resolved, surfaces, recipe.level, recipe.lots);
}

/** The ground of a building's lots as drawn: each lot's surface, and the level a parking bay outside every lot is laid at. */
function lotGroundOf(b: Building, surfaces: readonly LotPlane[], level: number | undefined, lots: boolean): LotGround | undefined {
  const bays = (b.elements ?? []).filter((el) => el.kind === 'parking').map((el) => {
    const [x0, y0, x1, y1] = elementRect(el);
    return [localToWorld(b, x0, y0), localToWorld(b, x1, y0), localToWorld(b, x1, y1), localToWorld(b, x0, y1)];
  });
  if (surfaces.length === 0 && bays.length === 0) return undefined;
  // The box of every lot and bay: a point outside it is off them all, found without a ring test each
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of [...surfaces.map((s) => s.ring), ...bays]) {
    for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  }
  return {
    recipe: { level, lots },
    heightAt(x, y) {
      if (x < x0 || x > x1 || y < y0 || y > y1) return NaN;
      for (const s of surfaces) if (insideRing(s.ring, x, y)) return s.heightAt(x, y);
      if (level !== undefined) for (const ring of bays) if (insideRing(ring, x, y)) return level;
      return NaN;
    },
  };
}

function insideRing(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, c = ring[j]!;
    if ((a.y > y) !== (c.y > y) && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const ELEMENT_CONCRETE: Paint = paint({ finish: 'concrete', colour: 0xcfcac0 });

/** What an element is made of until the player says otherwise. */
function elementPaint(b: Building, kind: BuildingElement['kind']): Paint {
  switch (kind) {
    case 'canopy': return ELEMENT_CONCRETE;
    case 'wall': return paint(paletteOf(b).wall);
    case 'stair':
    case 'ramp':
    case 'pavement': return PAVING;
    case 'fence': return paint({ finish: 'metal', colour: 0x4b5153 });
    case 'tree': return TRUNK;
    case 'bench': return paint({ finish: 'wood', colour: 0x8a6a45 });
    case 'ac': return paint({ finish: 'metal', colour: 0xd7dade });
    case 'planter': return paint({ finish: 'concrete', colour: 0xb9b3a8 });
    default: return ELEMENT_CONCRETE;
  }
}

const CLOCK_FACE = paint({ finish: 'plaster', colour: 0xf4f1e8 });
const CLOCK_INK = paint({ finish: 'metal', colour: 0x23272b });

/** A facade clock: a pale dial on a dark rim, twelve marks and two hands standing just proud of it */
function emitClock(e: Emitter, el: BuildingElement, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): void {
  e.box(x0, y0, x1, y1, z0, z1, CLOCK_INK);
  const along = el.facing === 0 || el.facing === 2;
  const a0 = along ? x0 : y0;
  const a1 = along ? x1 : y1;
  // The front plane and the way out of it.
  const front = el.facing === 0 ? y0 : el.facing === 2 ? y1 : el.facing === 1 ? x1 : x0;
  const out = el.facing === 0 || el.facing === 3 ? -1 : 1;
  const size = Math.min(a1 - a0, z1 - z0);
  const ca = (a0 + a1) / 2;
  const cz = (z0 + z1) / 2;
  const layer = (u0: number, u1: number, h0: number, h1: number, d0: number, d1: number, c: Paint): void => {
    const p0 = front + out * d0;
    const p1 = front + out * d1;
    if (along) e.box(u0, Math.min(p0, p1), u1, Math.max(p0, p1), h0, h1, c);
    else e.box(Math.min(p0, p1), u0, Math.max(p0, p1), u1, h0, h1, c);
  };
  const r = size * 0.42;
  layer(ca - r, ca + r, cz - r, cz + r, 0, m(0.04), CLOCK_FACE);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const ua = ca + Math.sin(a) * r * 0.82;
    const uz = cz + Math.cos(a) * r * 0.82;
    const t = size * (k % 3 === 0 ? 0.05 : 0.03);
    layer(ua - t, ua + t, uz - t, uz + t, m(0.04), m(0.07), CLOCK_INK);
  }
  const w = size * 0.03;
  layer(ca - w, ca + w, cz, cz + r * 0.55, m(0.07), m(0.1), CLOCK_INK);
  layer(ca, ca + r * 0.78, cz - w, cz + w, m(0.1), m(0.12), CLOCK_INK);
}

/** The parts of a grown lot nothing holds up (`unsupportedElements`): DO NOT work them out again for the building's lot after its body (`emitBuilding`, `emitLots`), each pair of parts clipped against each other: once a record (records are replaced, never changed). */
const looseParts = identityMemo((b: Building): ReadonlySet<number> | null => {
  if (b.lotPlan === undefined || !b.elements?.length) return null;
  const loose = unsupportedElements(b);
  return loose.size ? loose : null;
});

/** One free element: its boxes, its pavings and its fences' rails the shell's parts, instanced (`shellParts.ts`); the rest laid in the shell. */
function emitElement(e: Emitter, el: BuildingElement, floor: number, bottom: number, c: Paint,
  surface?: (lx: number, ly: number) => number): void {
  const was = e.inElement;
  e.inElement = true;
  try {
    layElement(e, el, floor, bottom, c, surface);
  } finally {
    e.inElement = was;
  }
}

function layElement(e: Emitter, el: BuildingElement, floor: number, bottom: number, c: Paint,
  surface?: (lx: number, ly: number) => number): void {
  const [x0, y0, x1, y1] = elementRect(el);
  const zb = onGround(el) ? bottom : floor + el.z;
  const z0 = floor + el.z;
  const z1 = z0 + el.h;
  if (el.kind === 'clock') {
    emitClock(e, el, x0, y0, x1, y1, z0, z1);
    return;
  }
  if (el.kind === 'stair' || el.kind === 'ramp') {
    // The run measured from the foot (the `facing` end) inwards.
    const sub = (u0: number, u1: number): [number, number, number, number] => {
      switch (el.facing) {
        case 0: return [x0, y0 + u0, x1, y0 + u1];
        case 2: return [x0, y1 - u1, x1, y1 - u0];
        case 3: return [x0 + u0, y0, x0 + u1, y1];
        default: return [x1 - u1, y0, x1 - u0, y1];
      }
    };
    if (el.kind === 'stair' && el.angle) {
      // A stair laid along a traced path
      emitTurnedStair(e, el, z0, zb, c);
      return;
    }
    if (el.kind === 'stair') {
      const n = stairSteps(el);
      const tread = el.d / n;
      // A low flight is solid, like steps cast in place.
      if (el.h <= STAIR_SOLID) {
        for (let k = 0; k < n; k++) {
          const [a0, b0, a1, b1] = sub(k * tread, (k + 1) * tread);
          e.box(a0, b0, a1, b1, zb, z0 + ((k + 1) * el.h) / n, c);
        }
        // Three steps up to a door without a rail read as a heap of blocks: a flight taller than a kerb carries its handrail too.
        if (el.h > m(0.5)) emitStairRails(e, el, [x0, y0, x1, y1], z0);
        return;
      }
      emitOpenStair(e, el, [x0, y0, x1, y1], z0, zb, c);
      return;
    }
    // A ramp: its slope, rising from the foot, over two cheeks.
    const foot = sub(0, 0);
    const head = sub(el.d, el.d);
    const [fa0, fb0, fa1, fb1] = foot;
    const [ha0, hb0, ha1, hb1] = head;
    const nf = SIDE_NORMAL[el.facing];
    const slope = el.h / el.d;
    const alongX = el.facing === 1 || el.facing === 3;
    const footPts: [V3, V3] = alongX ? [e.L(fa0, fb0, z0), e.L(fa0, fb1, z0)] : [e.L(fa0, fb0, z0), e.L(fa1, fb0, z0)];
    const headPts: [V3, V3] = alongX ? [e.L(ha0, hb0, z1), e.L(ha0, hb1, z1)] : [e.L(ha0, hb0, z1), e.L(ha1, hb0, z1)];
    e.shell.face([footPts[0], footPts[1], headPts[1], headPts[0]], e.N(nf.x * slope, nf.y * slope, 1), c);
    const cheek = (i: 0 | 1, n: V3): void => {
      const f = footPts[i];
      const h = headPts[i];
      e.shell.face([[f[0], f[1], zb], [h[0], h[1], zb], h, f], n, c);
    };
    const t = alongX ? e.N(0, 1) : e.N(1, 0);
    cheek(0, [-t[0], -t[1], 0]);
    cheek(1, t);
    e.shell.face([[footPts[0][0], footPts[0][1], zb], [footPts[1][0], footPts[1][1], zb], footPts[1], footPts[0]], e.N(nf.x, nf.y), c);
    e.shell.face([[headPts[0][0], headPts[0][1], zb], [headPts[1][0], headPts[1][1], zb], headPts[1], headPts[0]], e.N(-nf.x, -nf.y), c);
    return;
  }
  // Trees, shrubs and hedges are the scenery's plants (`scenery.ts`, `buildGardens`)
  if (el.kind === 'tree' || el.kind === 'shrub' || el.kind === 'hedge') return;
  if (el.kind === 'railing') {
    emitFence(e, el, z0, z1, c, true);
    return;
  }
  if (el.kind === 'flowers') {
    emitFlowers(e, el, z0, zb);
    return;
  }
  if (el.kind === 'rocks') {
    emitRocks(e, el, z0, zb, c);
    return;
  }
  if (el.kind === 'parking') {
    emitParking(e, el, z0, surface);
    return;
  }
  if (el.kind === 'gate' || el.kind === 'bin' || el.kind === 'lamp' || el.kind === 'bollard' || el.kind === 'drain') {
    emitLotPart(e, el, x0, y0, x1, y1, z0, zb, c);
    return;
  }
  if (el.kind === 'awning') {
    // A canvas falling from the wall to its free edge, with a valance.
    const drop = el.h;
    const free = sub2(el, [x0, y0, x1, y1], 0.92, 1);
    const n = SIDE_NORMAL[el.facing];
    e.box(x0, y0, x1, y1, z0 - drop * 0.55, z0 + drop * 0.1, shadeOf(el));
    e.box(free[0], free[1], free[2], free[3], z0 - drop * 0.8, z0 - drop * 0.45, shadeOf(el));
    void n;
    return;
  }
  if (el.kind === 'fence') {
    emitFence(e, el, z0, z1, c);
    return;
  }
  if (el.kind === 'bench') {
    // A seat on two legs and a back, facing the way it faces.
    e.box(x0, y0, x1, y1, z0 + m(0.35), z0 + m(0.45), c);
    const back = sub2(el, [x0, y0, x1, y1], 0, 0.12);
    e.box(back[0], back[1], back[2], back[3], z0 + m(0.45), z0 + m(0.95), c);
    for (const u of [0.15, 0.85]) {
      const leg = sub2(el, [x0, y0, x1, y1], u - 0.06, u + 0.06);
      e.box(leg[0], leg[1], leg[2], leg[3], zb, z0 + m(0.35), shaded(c, 0.85));
    }
    return;
  }
  if (el.kind === 'ac') {
    // A wall unit: the case, and a grille plate on the side it faces
    e.box(x0, y0, x1, y1, z0, z1, c);
    const g = sub2(el, [x0, y0, x1, y1], 0, 0.09);
    const end = m(0.04);
    if (el.facing === 0 || el.facing === 2) e.box(g[0] + end, g[1] - PART_INSET, g[2] - end, g[3], z0 + m(0.1), z1 - m(0.06), RAIL);
    else e.box(g[0] - PART_INSET, g[1] + end, g[2], g[3] - end, z0 + m(0.1), z1 - m(0.06), RAIL);
    return;
  }
  if (el.kind === 'planter') {
    e.box(x0, y0, x1, y1, zb, z1, c);
    const soil = m(0.06);
    e.box(x0 + soil, y0 + soil, x1 - soil, y1 - soil, z1 - m(0.05), z1 + m(0.02), PLANTER_SOIL);
    return;
  }
  if (el.kind === 'canopy') {
    // A cantilevered slab: a fascia down its free edge (the drip) and two steel brackets under it back to the wall.
    e.box(x0, y0, x1, y1, z0, z1, c);
    const n = SIDE_NORMAL[el.facing];
    const lip = m(0.05);
    // The fascia a little proud of the slab's edge and over its top
    const out = PART_INSET;
    const [lx0, ly0, lx1, ly1] = el.facing === 0 ? [x0, y0 - out, x1, y0 + lip] : el.facing === 2 ? [x0, y1 - lip, x1, y1 + out] : el.facing === 3 ? [x0 - out, y0, x0 + lip, y1] : [x1 - lip, y0, x1 + out, y1];
    e.box(lx0 - Math.abs(n.y) * lip, ly0 - Math.abs(n.x) * lip, lx1 + Math.abs(n.y) * lip, ly1 + Math.abs(n.x) * lip, z0 - m(0.12), z1 + out, shaded(c, 0.95));
    const across = el.facing === 0 || el.facing === 2;
    for (const t of [0.15, 0.85]) {
      const bx = across ? x0 + (x1 - x0) * t : (x0 + x1) / 2;
      const by = across ? (y0 + y1) / 2 : y0 + (y1 - y0) * t;
      const half = el.d * 0.35;
      e.box(
        across ? bx - m(0.04) : bx - half,
        across ? by - half : by - m(0.04),
        across ? bx + m(0.04) : bx + half,
        across ? by + half : by + m(0.04),
        z0 - m(0.35),
        z0,
        RAIL,
      );
    }
    return;
  }
  if (el.kind === 'wall' && onGround(el) && el.h <= m(3.2)) {
    // A boundary wall: its body, a darker plinth at the foot where the rain splashes
    const along = x1 - x0 >= y1 - y0;
    const lip = m(0.04);
    const cap = m(0.07);
    // And walls that cross in plan (a sink set against another of the yard's walls, 2026-10-13) each at a course of their own
    const foot = z0 + (along ? m(0.22) : m(0.23)) + m(0.02) * (el.id % 3);
    // Past the ends by `PART_INSET`; the plinth and the coping proud of both faces by `lip`.
    const ex = along ? PART_INSET : 0, ey = along ? 0 : PART_INSET;
    const gx = along ? PART_INSET : lip, gy = along ? lip : PART_INSET;
    e.box(x0 - ex, y0 - ey, x1 + ex, y1 + ey, foot, z1 - cap, c);
    e.box(x0 - gx, y0 - gy, x1 + gx, y1 + gy, zb, foot, shaded(c, 0.78));
    e.box(x0 - gx, y0 - gy, x1 + gx, y1 + gy, z1 - cap, z1, COPING, COPING);
    return;
  }
  if (el.kind === 'pavement') {
    // A paving's sides stand in from its top's edge (`COVER_INSET`): a wall or a gate on that edge keeps the face there.
    e.slab(x0, y0, x1, y1, zb, z1, COVER_INSET, c);
    return;
  }
  e.box(x0, y0, x1, y1, zb, z1, c);
}

const COPING: Paint = paint({ finish: 'stone', colour: 0xc9c3b6 });
const APRON = m(0.9);
const PATH_WIDTH = m(1.4);
const PATH_REACH = m(14);
const LOT_LIFT = m(0.024);
const PAVING: Paint = paint({ finish: 'stone', colour: 0xbdb5a6 });

/** Where a door's flight of steps stands along its side, in the side's own axis (`sideStart`) */
function flightSpan(b: Building, v: Volume, x: Entrance): [number, number] {
  const o = openingOf(x.component, x.width, levelHeight(b, 0)) ?? { a0: x.width * 0.2, a1: x.width * 0.8 };
  const half = (o.a1 - o.a0 + m(0.5)) / 2;
  const middle = x.index * bayWidth(b, v, x.side) + x.width / 2;
  return [middle - half, middle + half];
}

/** A rectangle of the plan, local: x0, y0, x1, y1. */
type PlanRect = readonly [number, number, number, number];

/** The ground the doors' flights of steps stand on, in the plan (local rectangles) */
function flightFeet(b: Building, groundAt: GroundAt, pavedAt: PavedAt | undefined, floor: number, entrances?: readonly Entrance[]): PlanRect[] {
  // The body's own list (`emitChunk`): its doors read off the bays it laid out (`bayLayout`), not worked out again.
  const closed = closedBlocks(b.volumes);
  if (closed.length === 0) return [];
  const built = { ...b, volumes: closed };
  const out: PlanRect[] = [];
  // The body's own (`emitBuilding`, the same floor and ground storey); worked out here only for a signature body, drawn by its own parts.
  for (const x of entrances ?? foundationOf(built, groundAt, undefined, pavedAt, floor).entrances) {
    if (x.steps <= 0 || x.recess > 0) continue;
    const v = closed.find((w) => w.id === x.volume);
    if (!v) continue;
    const [a0, a1] = flightSpan(built, v, x);
    const s = sideStart(v, x.side), n = edgeFrame(v, x.side);
    const xs: number[] = [], ys: number[] = [];
    for (const a of [a0, a1]) {
      for (const d of [x.push, x.push + flightRun(x.steps)]) {
        xs.push(s.x + s.tx * a + n.nx * d);
        ys.push(s.y + s.ty * a + n.ny * d);
      }
    }
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

/** A level piece of paving with the ground of the flights taken out of it: what is left, in pieces of the same kind. */
function clearOf(piece: BuildingElement, feet: readonly PlanRect[]): BuildingElement[] {
  if (feet.length === 0 || piece.angle) return [piece];
  let left: PlanRect[] = [elementRect(piece)];
  let cut = false;
  for (const [fx0, fy0, fx1, fy1] of feet) {
    const next: PlanRect[] = [];
    for (const r of left) {
      const [x0, y0, x1, y1] = r;
      if (fx0 >= x1 || fx1 <= x0 || fy0 >= y1 || fy1 <= y0) { next.push(r); continue; }
      cut = true;
      // The parts of `r` round the foot: below, above, then left and right between them.
      if (fy0 > y0) next.push([x0, y0, x1, fy0]);
      if (fy1 < y1) next.push([x0, fy1, x1, y1]);
      const my0 = Math.max(y0, fy0), my1 = Math.min(y1, fy1);
      if (fx0 > x0) next.push([x0, my0, fx0, my1]);
      if (fx1 < x1) next.push([fx1, my0, x1, my1]);
    }
    left = next;
  }
  if (!cut) return [piece];
  return left
    .filter(([x0, y0, x1, y1]) => x1 - x0 > m(0.05) && y1 - y0 > m(0.05))
    .map(([x0, y0, x1, y1]) => ({ ...piece, facing: 0, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, d: y1 - y0 }));
}

/** What seats a building in its lot: a paved apron round the base of every ground volume, laid on the land */
function emitLot(e: Emitter, b: Building, f: Foundation, groundAt: GroundAt, pavedAt: PavedAt | undefined): void {
  const paved = (x: number, y: number): boolean => pavedAt !== undefined && Number.isFinite(pavedAt(x, y));
  const up: V3 = [0, 0, 1];
  const strip = (from: Vec2, to: Vec2, width: number, nx: number, ny: number): void => {
    // A strip `width` out from the line from -> to (local), along normal (nx, ny).
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const pieces = Math.max(1, Math.ceil(length / m(2)));
    for (let i = 0; i < pieces; i++) {
      const a = { x: from.x + ((to.x - from.x) * i) / pieces, y: from.y + ((to.y - from.y) * i) / pieces };
      const c = { x: from.x + ((to.x - from.x) * (i + 1)) / pieces, y: from.y + ((to.y - from.y) * (i + 1)) / pieces };
      const quad = [a, c, { x: c.x + nx * width, y: c.y + ny * width }, { x: a.x + nx * width, y: a.y + ny * width }];
      const world = quad.map((p) => e.L(p.x, p.y, 0));
      if (world.some((w) => paved(w[0], w[1]))) continue;
      e.shell.face(world.map((w) => [w[0], w[1], groundAt(w[0], w[1]) + LOT_LIFT] as V3), up, PAVING);
    }
  };
  // The flights standing out of the sides (by block and side): the apron is laid round their feet, not through them.
  const flights = new Map<string, { a0: number; a1: number; run: number }[]>();
  for (const x of f.entrances) {
    if (x.steps <= 0 || x.recess > 0) continue;
    const v = b.volumes.find((w) => w.id === x.volume);
    if (!v) continue;
    const [a0, a1] = flightSpan(b, v, x);
    const key = `${x.volume}:${x.side}`;
    flights.set(key, [...(flights.get(key) ?? []), { a0, a1, run: flightRun(x.steps) }]);
  }
  for (const v of b.volumes) {
    if (v.base !== 0) continue;
    const g = PLINTH_GROW;
    // Round the footprint the way it runs
    const ring = localFootprint(v);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < 1e-6) continue;
      const tx = (q.x - p.x) / length, ty = (q.y - p.y) / length;
      const n = { x: ty, y: -tx };
      // Only along the outside: against another block of the ground the apron lay inside the building.
      const s = sideStart(v, i as FaceId);
      const reversed = s.tx * tx + s.ty * ty < 0;
      const toRing = ([a0, a1]: readonly [number, number]): [number, number] => (reversed ? [length - a1, length - a0] : [a0, a1]);
      const steps = (flights.get(`${v.id}:${i}`) ?? []).map((fl) => ({ span: toRing([fl.a0, fl.a1]), run: fl.run }));
      const covered = [...coveredSpans(b, v, i as FaceId, 0).map(toRing), ...steps.map((fl) => fl.span)]
        .sort((u, w) => u[0] - w[0]);
      for (const [p0, p1] of exposedParts(covered, 0, length)) {
        // Grown past the corner it starts from, to the plinth at the one it ends at.
        const a0 = p0 < 1e-6 ? -(g + APRON) : p0, a1 = p1 > length - 1e-6 ? length + g : p1;
        const from = { x: p.x + tx * a0 + n.x * g, y: p.y + ty * a0 + n.y * g };
        const to = { x: p.x + tx * a1 + n.x * g, y: p.y + ty * a1 + n.y * g };
        strip(from, to, APRON, n.x, n.y);
      }
      // In front of a flight, only past its foot.
      for (const { span: [s0, s1], run } of steps) {
        const out = Math.max(g, run);
        if (out >= g + APRON - 1e-6) continue;
        const from = { x: p.x + tx * s0 + n.x * out, y: p.y + ty * s0 + n.y * out };
        const to = { x: p.x + tx * s1 + n.x * out, y: p.y + ty * s1 + n.y * out };
        strip(from, to, g + APRON - out, n.x, n.y);
      }
    }
  }
  for (const x of f.entrances) {
    if (!pavedAt) break;
    // Where the paving is right there, the entrance already opens onto it.
    let reach = 0;
    for (let d = APRON; d <= PATH_REACH; d += m(0.5)) {
      if (paved(x.x + x.nx * d, x.y + x.ny * d)) {
        reach = d;
        break;
      }
    }
    if (reach <= APRON + m(0.5)) continue;
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    // The entrance's point and normal in the local frame.
    const lx = (x.x - b.x) * c + (x.y - b.y) * s;
    const ly = -(x.x - b.x) * s + (x.y - b.y) * c;
    const nx = x.nx * c + x.ny * s;
    const ny = -x.nx * s + x.ny * c;
    const start = APRON + m(0.1) + flightRun(x.steps);
    const half = PATH_WIDTH / 2;
    strip(
      { x: lx + nx * start - ny * half, y: ly + ny * start + nx * half },
      { x: lx + nx * start + ny * half, y: ly + ny * start - nx * half },
      reach - start,
      nx,
      ny,
    );
  }
}

/** A flight taller than this is built open: treads on a raking slab, with handrails. */
const STAIR_SOLID = m(1.2);
const TREAD = m(0.05);
const WAIST = m(0.25);
const HANDRAIL = m(0.95);

/** A tall flight as it is really built: every step a tread and a riser, the lot carried by a raking concrete slab */
function emitOpenStair(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
  zb: number,
  c: Paint,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  // A point `u` along the run from the foot, `a` across it, at height z.
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const out = e.N(nf.x, nf.y);
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  for (let k = 0; k < n; k++) {
    const top = z0 + (k + 1) * riser;
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    // The riser (down to the step below, or to the ground for the first) and the tread.
    const below = k === 0 ? zb : z0 + k * riser - TREAD;
    e.shell.face([P(u0, 0, below), P(u0, w, below), P(u0, w, top), P(u0, 0, top)], out, c);
    e.shell.face([P(u0, 0, top), P(u0, w, top), P(u1, w, top), P(u1, 0, top)], [0, 0, 1], c);
    // The step's ends, down to the waist.
    const base = Math.max(zb, z0 + (el.h * u0) / el.d - WAIST);
    e.shell.face([P(u0, 0, base), P(u1, 0, base), P(u1, 0, top), P(u0, 0, top)], back, c);
    e.shell.face([P(u1, w, base), P(u0, w, base), P(u0, w, top), P(u1, w, top)], across, c);
  }
  // The waist: a raking slab under the steps, from the ground up to the top.
  const slope = el.h / el.d;
  const soffit = (u: number): number => Math.max(zb, z0 + slope * u - WAIST);
  e.shell.face([P(0, 0, soffit(0)), P(0, w, soffit(0)), P(el.d, w, soffit(el.d)), P(el.d, 0, soffit(el.d))], e.N(-nf.x * slope, -nf.y * slope, -1), c);
  emitStairRails(e, el, [x0, y0, x1, y1], z0);
}

/** The handrail of a flight: a slim rail over each edge, at a constant height above the nosings */
function emitStairRails(
  e: Emitter,
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  z0: number,
): void {
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const P = (u: number, a: number, z: number): V3 => {
    switch (el.facing) {
      case 0: return e.L(x0 + a, y0 + u, z);
      case 2: return e.L(x0 + a, y1 - u, z);
      case 3: return e.L(x0 + u, y0 + a, z);
      default: return e.L(x1 - u, y0 + a, z);
    }
  };
  const nf = SIDE_NORMAL[el.facing];
  const slope = el.h / el.d;
  const across = el.facing === 0 || el.facing === 2 ? e.N(1, 0) : e.N(0, 1);
  const back: V3 = [-across[0], -across[1], 0];
  const w = el.w;
  const rail = m(0.05);
  for (const a of [rail, w - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, a - rail, r0), P(0, a + rail, r0), P(el.d, a + rail, r1), P(el.d, a - rail, r1)], e.N(nf.x * slope, nf.y * slope, 1), RAIL);
    e.shell.face([P(0, a + rail, r0 - rail * 2), P(el.d, a + rail, r1 - rail * 2), P(el.d, a + rail, r1), P(0, a + rail, r0)], across, RAIL);
    e.shell.face([P(el.d, a - rail, r1 - rail * 2), P(0, a - rail, r0 - rail * 2), P(0, a - rail, r0), P(el.d, a - rail, r1)], back, RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    for (let k = 0; k < n; k += every) postAt(e, P, k * tread + tread / 2, a, z0 + (k + 1) * riser, HANDRAIL);
    postAt(e, P, el.d - tread / 2, a, z0 + el.h, HANDRAIL);
  }
}

const RAIL: Paint = paint({ finish: 'metal', colour: 0x3a3f42 });
const PLANTER_SOIL: Paint = paint({ finish: 'wood', colour: 0x3d2f22 });
const TRUNK: Paint = paint({ finish: 'wood', colour: 0x5a4632 });

/** A rectangle inside an element's plan, as fractions of the axis its `d` runs on: 0 at the edge it faces, 1 at its back. */
function sub2(
  el: BuildingElement,
  [x0, y0, x1, y1]: [number, number, number, number],
  u0: number,
  u1: number,
): [number, number, number, number] {
  if (el.facing === 0 || el.facing === 2) {
    const a = y0 + (y1 - y0) * u0;
    const b = y0 + (y1 - y0) * u1;
    return [x0, Math.min(a, b), x1, Math.max(a, b)];
  }
  const a = x0 + (x1 - x0) * u0;
  const b = x0 + (x1 - x0) * u1;
  return [Math.min(a, b), y0, Math.max(a, b), y1];
}

/** A flight laid along a traced path */
function emitTurnedStair(e: Emitter, el: BuildingElement, z0: number, zb: number, c: Paint): void {
  const a = el.angle ?? 0;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // A point `u` along the run from the foot, `v` across it, at height z.
  const P = (u: number, v: number, z: number): V3 =>
    e.L(el.x + u * ca - v * sa, el.y + u * sa + v * ca, z);
  const hw = el.w / 2;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const across: V3 = e.N(-sa, ca, 0);
  const back: V3 = e.N(-ca, -sa, 0);
  for (let k = 0; k < n; k++) {
    const u0 = k * tread;
    const u1 = (k + 1) * tread;
    const top = z0 + (k + 1) * riser;
    const base = k === 0 ? zb : z0 + k * riser - m(0.08);
    // The riser, then the tread.
    e.shell.face([P(u0, -hw, base), P(u0, hw, base), P(u0, hw, top), P(u0, -hw, top)], back, c);
    e.shell.face([P(u0, -hw, top), P(u0, hw, top), P(u1, hw, top), P(u1, -hw, top)], e.N(0, 0, 1), c);
    // The two cheeks, down to the flight's underside.
    const under = Math.max(zb, z0 + el.h * (u0 / el.d) - m(0.25));
    e.shell.face([P(u0, -hw, under), P(u1, -hw, under), P(u1, -hw, top), P(u0, -hw, top)], e.N(-across[0], -across[1], 0), c);
    e.shell.face([P(u1, hw, under), P(u0, hw, under), P(u0, hw, top), P(u1, hw, top)], across, c);
  }
  emitRailLine(e, P, el, z0, hw);
}

/** Both handrails of a flight in an arbitrary frame. */
function emitRailLine(
  e: Emitter,
  P: (u: number, v: number, z: number) => V3,
  el: BuildingElement,
  z0: number,
  hw: number,
): void {
  if (el.h < m(0.5)) return;
  const n = stairSteps(el);
  const tread = el.d / n;
  const riser = el.h / n;
  const rail = m(0.05);
  for (const v of [-hw + rail, hw - rail]) {
    const r0 = z0 + riser + HANDRAIL;
    const r1 = z0 + el.h + HANDRAIL;
    e.shell.face([P(0, v - rail, r0), P(0, v + rail, r0), P(el.d, v + rail, r1), P(el.d, v - rail, r1)], e.N(0, 0, 1), RAIL);
    const every = Math.max(1, Math.round(m(1.2) / tread));
    for (let k = 0; k < n; k += every) postAt(e, P, k * tread + tread / 2, v, z0 + (k + 1) * riser, HANDRAIL);
  }
}

/** A run of fence: posts and two rails along the box's length. */
function emitFence(e: Emitter, el: BuildingElement, z0: number, z1: number, c: Paint, light = false): void {
  const half = el.w / 2;
  const at = (u: number, v: number): { x: number; y: number } => {
    const a = el.angle ?? 0;
    const across = el.facing === 0 || el.facing === 2 ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const ux = across.x * Math.cos(a) - across.y * Math.sin(a);
    const uy = across.x * Math.sin(a) + across.y * Math.cos(a);
    const vx = -uy;
    const vy = ux;
    return { x: el.x + ux * u + vx * v, y: el.y + uy * u + vy * v };
  };
  const t = light ? m(0.03) : m(0.06);
  // The rails, boxes a post wide: as two flat ribbons they had no sides to see
  const railTop = z0 + el.h - m(0.07) - RAIL_OFF;
  const railMid = z0 + el.h * 0.45 + RAIL_OFF;
  const a = at(-half, 0), b = at(half, 0);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const r = m(0.02);
  for (const [z, tall] of [[railMid, m(0.06)], [railTop, m(0.07)]] as const) {
    // An instance of the shell's rail, turned along the run (`shellParts.ts`).
    if (e.apart && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      e.shellPart('lotRail', a.x + (ux * len) / 2, a.y + (uy * len) / 2, z, z + tall, len, 2 * r, Math.atan2(uy, ux), c);
      continue;
    }
    const q = (u: number, v: number, h: number): V3 => e.L(a.x + ux * u - uy * v, a.y + uy * u + ux * v, h);
    e.shell.face([q(0, -r, z), q(len, -r, z), q(len, -r, z + tall), q(0, -r, z + tall)], e.N(uy, -ux), c);
    e.shell.face([q(len, r, z), q(0, r, z), q(0, r, z + tall), q(len, r, z + tall)], e.N(-uy, ux), c);
    e.shell.face([q(0, -r, z + tall), q(len, -r, z + tall), q(len, r, z + tall), q(0, r, z + tall)], [0, 0, 1], c);
    e.shell.face([q(0, r, z), q(len, r, z), q(len, -r, z), q(0, -r, z)], [0, 0, -1], c);
  }
  // Posts every couple of metres on a fence, closer together on a railing, at both ends
  const spacing = light ? m(0.45) : m(2);
  const posts = Math.max(2, Math.round(el.w / spacing) + 1);
  const reach = Math.max(0, half - t - PART_INSET);
  for (let k = 0; k < posts; k++) {
    const u = -reach + (2 * reach * k) / (posts - 1);
    const p = at(u, 0);
    e.box(p.x - t, p.y - t, p.x + t, p.y + t, z0, z1 + m(0.05), c);
  }
}
/** A fence rail's height off the whole centimetre: 5 mm. */
const RAIL_OFF = m(0.005);
const FLOWER_KERB: Paint = paint({ finish: 'stone', colour: 0xa9a196 });

/** A flower bed: soil in a stone kerb, with a handful of coloured blooms. */
function emitFlowers(e: Emitter, el: BuildingElement, z0: number, bottom: number): void {
  const kerb = m(0.12);
  e.box(el.x - el.w / 2, el.y - el.d / 2, el.x + el.w / 2, el.y + el.d / 2, bottom, z0 + m(0.16), FLOWER_KERB);
  e.box(el.x - el.w / 2 + kerb, el.y - el.d / 2 + kerb, el.x + el.w / 2 - kerb, el.y + el.d / 2 - kerb, z0 + m(0.1), z0 + m(0.2), PLANTER_SOIL);
  // The flowers themselves are the scenery's (`buildGardens`).
}

/** Boulders: two or three low prisms, each turned a little. */
function emitRocks(e: Emitter, el: BuildingElement, z0: number, bottom: number, c: Paint): void {
  const count = 3;
  for (let k = 0; k < count; k++) {
    const h = Math.abs(Math.round(Math.sin(el.id * 3.7 + k * 12.3) * 9127.13));
    const rx = ((h % 100) / 100 - 0.5) * (el.w - m(0.4));
    const ry = (((h >> 3) % 100) / 100 - 0.5) * (el.d - m(0.4));
    const r = m(0.22) + ((h >> 7) % 5) * m(0.05);
    const top = z0 + el.h * (0.5 + ((h >> 5) % 4) * 0.12);
    const t = z0 + (el.h - (top - z0)) * 0.3;
    const p = (dx: number, dy: number, dz: number): V3 => e.L(el.x + rx + dx, el.y + ry + dy, dz);
    const base: V3[] = [p(-r, -r, bottom), p(r, -r, bottom), p(r, r, bottom), p(-r, r, bottom)];
    const apex: V3[] = [p(-r * 0.4, -r * 0.35, top), p(r * 0.45, -r * 0.3, top), p(r * 0.35, r * 0.4, top), p(-r * 0.45, r * 0.35, top)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const q = (i + 0.5) * 0.25 * Math.PI * 2;
      e.shell.face([base[i] as V3, base[j] as V3, apex[j] as V3, apex[i] as V3], e.N(Math.cos(q), Math.sin(q), 0.3), c);
    }
    e.shell.face([apex[0] as V3, apex[1] as V3, apex[2] as V3, apex[3] as V3], e.N(0, 0, 1), c);
    void t;
  }
}

/** A parking apron: asphalt and the stall lines painted on it. */
function emitParking(e: Emitter, el: BuildingElement, z0: number, surface?: (lx: number, ly: number) => number): void {
  // Laid on the lot, following its fall
  const lift = (lx: number, ly: number, dz: number): V3 => e.L(lx, ly, (surface ? surface(lx, ly) : z0) + dz);
  const quad = (x0: number, y0: number, x1: number, y1: number, dz: number, look: Paint): void => {
    e.shell.face([lift(x0, y0, dz), lift(x1, y0, dz), lift(x1, y1, dz), lift(x0, y1, dz)], [0, 0, 1], look);
  };
  const ax = el.x - el.w / 2, ay = el.y - el.d / 2;
  const n = Math.max(1, Math.ceil(Math.max(el.w, el.d) / m(3)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      quad(ax + (el.w * i) / n, ay + (el.d * j) / n, ax + (el.w * (i + 1)) / n, ay + (el.d * (j + 1)) / n, m(0.03), PARKING_ASPHALT);
    }
  }
  const stalls = Math.max(1, Math.floor(el.w / m(2.5)));
  const line = m(0.1);
  const along = el.facing === 0 || el.facing === 2;
  for (let k = 0; k <= stalls; k++) {
    const u = -el.w / 2 + (el.w * k) / stalls;
    if (along) quad(el.x + u - line / 2, ay, el.x + u + line / 2, ay + el.d * 0.72, m(0.05), PARKING_LINE);
    else quad(ax, el.y + u - line / 2, ax + el.w * 0.72, el.y + u + line / 2, m(0.05), PARKING_LINE);
  }
}
const PARKING_ASPHALT: Paint = paint({ finish: 'concrete', colour: 0x4a4d4f });
const GATE_PAINT: Paint = paint({ finish: 'metal', colour: 0x2f3437 });
/** The narrowest gate drawn standing open: a car's (`sim/agents/parking.ts` `CAR_GATE`); a person's is 1.2-2 m. */
const CAR_GATE_OPEN = m(2.2);
/** A gate pillar's width along the gate. */
const GATE_POST = m(0.17);
const BIN_BODY: Paint = paint({ finish: 'metal', colour: 0x3d5a43 });
const BIN_LID: Paint = paint({ finish: 'metal', colour: 0x2b3a2e });
const LAMP_POST: Paint = paint({ finish: 'metal', colour: 0x40464a });
/** The lantern on a person's gate post: width and height, standing on the post's cap. */
const GATE_LANTERN = { w: m(0.16), h: m(0.24) } as const;
const BOLLARD_BAND: Paint = paint({ finish: 'plaster', colour: 0xe8e2cf });
const DRAIN_GRATE: Paint = paint({ finish: 'metal', colour: 0x26292b });

/** The furniture of a lot. */
function emitLotPart(e: Emitter, el: BuildingElement, x0: number, y0: number, x1: number, y1: number,
  z0: number, zb: number, c: Paint): void {
  const z1 = z0 + el.h;
  const alongX = el.facing === 0 || el.facing === 2;
  // A box spanning `u0..u1` along the part and `v0..v1` across it (fractions), at heights h0..h1.
  const part = (u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, look: Paint): void => {
    if (alongX) e.box(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * v0, x0 + (x1 - x0) * u1, y0 + (y1 - y0) * v1, h0, h1, look);
    else e.box(x0 + (x1 - x0) * v0, y0 + (y1 - y0) * u0, x0 + (x1 - x0) * v1, y0 + (y1 - y0) * u1, h0, h1, look);
  };
  const length = alongX ? x1 - x0 : y1 - y0;
  switch (el.kind) {
    case 'gate': {
      const look = el.material ? c : GATE_PAINT;
      // A gate's pillars stand proud of the wall either side of it
      const post = Math.min(0.2, GATE_POST / length);
      part(0, post, -0.4, 1.4, zb, z1 + m(0.1), look);
      part(1 - post, 1, -0.4, 1.4, zb, z1 + m(0.1), look);
      if (el.w < CAR_GATE_OPEN) {
        // A person's gate: a lantern on each post's cap, lit after dark.
        for (const u of [post / 2, 1 - post / 2]) {
          const v = 0.5;
          const lx = alongX ? x0 + (x1 - x0) * u : x0 + (x1 - x0) * v;
          const ly = alongX ? y0 + (y1 - y0) * v : y0 + (y1 - y0) * u;
          e.putAt('lamp', lx, ly, z1 + m(0.1) + GATE_LANTERN.h / 2, GATE_LANTERN.w, GATE_LANTERN.h, GATE_LANTERN.w);
        }
      }
      if (el.w >= CAR_GATE_OPEN) {
        // A car's gate: its two leaves swung open into the lot on their hinges at the posts, so the cars that use it
        const depth = el.d || m(0.12);
        const leaf = ((1 - 2 * post) * length) / 2 / depth;
        const inward = el.facing === 0 || el.facing === 3 ? 1 : -1;
        const v0 = inward > 0 ? 1 : -leaf, v1 = inward > 0 ? 1 + leaf : 0;
        const thin = m(0.05) / length;
        for (const u of [post, 1 - post - thin]) {
          part(u, u + thin, v0, v1, z0 + m(0.08), z0 + m(0.16), look);
          part(u, u + thin, v0, v1, z1 - m(0.1), z1, look);
          const bars = Math.max(2, Math.round((leaf * depth) / m(0.14)));
          for (let k = 0; k <= bars; k++) {
            const v = v0 + ((v1 - v0) * k) / bars;
            const bw = m(0.035) / depth;
            part(u, u + thin, v - bw / 2, v + bw / 2, z0 + m(0.08), z1, look);
          }
        }
        return;
      }
      {
        // A person's gate: its one leaf, hung on one post like a door, stands swung open into the lot
        const depth = el.d || m(0.12);
        const leaf = ((1 - 2 * post) * length) / depth;
        const inward = el.facing === 0 || el.facing === 3 ? 1 : -1;
        const v0 = inward > 0 ? 1 : -leaf, v1 = inward > 0 ? 1 + leaf : 0;
        const thin = m(0.05) / length;
        const u = post;
        part(u, u + thin, v0, v1, z0 + m(0.08), z0 + m(0.16), look);
        part(u, u + thin, v0, v1, z1 - m(0.1), z1, look);
        const bars = Math.max(2, Math.round((leaf * depth) / m(0.14)));
        for (let k = 0; k <= bars; k++) {
          const v = v0 + ((v1 - v0) * k) / bars;
          const bw = m(0.035) / depth;
          part(u, u + thin, v - bw / 2, v + bw / 2, z0 + m(0.08), z1, look);
        }
      }
      return;
    }
    case 'bin': {
      for (const [u0, u1] of [[0.02, 0.48], [0.52, 0.98]] as const) {
        part(u0, u1, 0.05, 0.95, zb, z1 - m(0.06), BIN_BODY);
        part(u0 - 0.01, u1 + 0.01, 0, 1, z1 - m(0.06), z1, BIN_LID);
      }
      return;
    }
    case 'lamp': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = m(0.06);
      e.box(cx - r, cy - r, cx + r, cy + r, zb, z1, LAMP_POST);
      e.box(cx - m(0.22), cy - m(0.22), cx + m(0.22), cy + m(0.22), z1, z1 + m(0.12), LAMP_POST);
      // The glass under the head: a lamp, lit after dark (`kit.ts`), not a pale box.
      e.putAt('lamp', cx, cy, z1 - m(0.04), m(0.36), m(0.08), m(0.36));
      return;
    }
    case 'bollard': {
      e.box(x0, y0, x1, y1, zb, z1, c === ELEMENT_CONCRETE ? LAMP_POST : c);
      e.box(x0 - m(0.01), y0 - m(0.01), x1 + m(0.01), y1 + m(0.01), z1 - m(0.25), z1 - m(0.15), BOLLARD_BAND);
      return;
    }
    default: {
      // The drain: a frame and its slots, a hair over the paving.
      e.box(x0, y0, x1, y1, z0, z0 + m(0.02), DRAIN_GRATE);
      for (let k = 1; k < 5; k++) part(k / 5 - 0.03, k / 5 + 0.03, 0.1, 0.9, z0 + m(0.02), z0 + m(0.025), LAMP_POST);
    }
  }
}
const PARKING_LINE: Paint = paint({ finish: 'plaster', colour: 0xe9e6dc });

/** The canvas colour of an awning, from the building's own palette. */
function shadeOf(el: BuildingElement): Paint {
  return el.material ? paint(el.material) : paint({ finish: 'plaster', colour: 0xc85a4a });
}

/** A slim square post of the handrail, from a tread up to the rail. */
function postAt(e: Emitter, P: (u: number, a: number, z: number) => V3, u: number, a: number, z: number, h: number): void {
  const r = m(0.025);
  const corners: V3[] = [P(u - r, a - r, 0), P(u + r, a - r, 0), P(u + r, a + r, 0), P(u - r, a + r, 0)];
  for (let i = 0; i < 4; i++) {
    const p = corners[i] as V3;
    const q = corners[(i + 1) % 4] as V3;
    const mid: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0];
    const centre: V3 = [(corners[0]![0] + corners[2]![0]) / 2, (corners[0]![1] + corners[2]![1]) / 2, 0];
    e.shell.face([[p[0], p[1], z], [q[0], q[1], z], [q[0], q[1], z + h], [p[0], p[1], z + h]], [mid[0] - centre[0], mid[1] - centre[1], 0], RAIL);
  }
}

/** A horizontal band around a volume at height z (a storey line or a cornice). */
function band(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint, hidden?: (side: FaceId) => [number, number][]): void {
  // A moulding is a PROFILE, not a slab
  const tier = (o: number, z0: number, z1: number, paint: Paint): void => flushBand(e, v, (z0 + z1) / 2, o, z1 - z0, paint, hidden);
  tier(out * 0.45, z - height / 2, z - height * 0.1, shaded(c, 0.94));
  tier(out, z - height * 0.1, z + height / 2, c);
}

/** A band flush with the wall, standing out only `out`: a slab edge, not a moulding. */
function flushBand(e: Emitter, v: Volume, z: number, out: number, height: number, c: Paint, hidden?: (side: FaceId) => [number, number][]): void {
  const ring = localFootprint(v);
  const z0 = z - height / 2, z1 = z + height / 2;
  // A rectangle's corners closed as the box closed them; a shaped block's as before.
  const grow = v.outline ? 0 : out;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length < 1e-6) continue;
    const tx = (q.x - p.x) / length, ty = (q.y - p.y) / length;
    const nx = ty, ny = -tx;
    const P = (a: number, o: number, h: number): V3 => e.L(p.x + tx * a + nx * o, p.y + ty * a + ny * o, h);
    // Only the stretches no other block covers; grown past a corner only at the side's own ends.
    for (const [s0, s1] of hidden ? exposedParts(hidden(i), 0, length) : [[0, length] as [number, number]]) {
      const a0 = s0 <= 1e-6 ? -grow : s0, a1 = s1 >= length - 1e-6 ? length + grow : s1;
      e.shell.face([P(a0, out, z0), P(a1, out, z0), P(a1, out, z1), P(a0, out, z1)], e.N(nx, ny), c);
      e.shell.face([P(a0, 0, z1), P(s1, 0, z1), P(s1, out, z1), P(a0, out, z1)], [0, 0, 1], c);
    }
  }
}

/** The stretches covered in both lists (sorted, each its own spans). */
function bothCovered(a: readonly [number, number][], b: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, a1] of a) for (const [b0, b1] of b) { const s = Math.max(a0, b0), t = Math.min(a1, b1); if (t > s + 1e-6) out.push([s, t]); }
  return out.sort((p, q) => p[0] - q[0]);
}

/** The shutters' paint: a colour of their own against the wall, as Brazilian houses paint them */
const SHUTTER_PAINTS = [new Color().setHex(0x55785c), new Color().setHex(0x557392), new Color().setHex(0x7a5538)];
/** A balcony slab's colour: the wall's own, a shade darker underneath the light (a slab of the building, not a white tray). */
const slabColours = new WeakMap<Paint, Color>();
function slabColour(wall: Paint): Color {
  let c = slabColours.get(wall);
  if (!c) { c = new Color().setRGB(wall.rgb[0] * 0.92, wall.rgb[1] * 0.92, wall.rgb[2] * 0.92); slabColours.set(wall, c); }
  return c;
}

function shutterColour(wall: Paint, trim: Paint): Color {
  const [r, g, b] = trim.rgb;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma > 0.06 && Math.max(r, g, b) < 0.75) return trimColour(trim);
  const [wr, wg, wb] = wall.rgb;
  return SHUTTER_PAINTS[wb > wr ? 2 : wg > wb ? 1 : 0]!;
}

function emitCornice(e: Emitter, v: Volume, z: number, trim: Paint): void {
  const crown = v.dress?.crown;
  if (crown === 'none' || crown === 'attic') return;
  // A thin roof slab standing well out: the crown of a modern block.
  if (crown === 'slab') { flushBand(e, v, z + PARAPET_H - m(0.12), m(0.45), m(0.26), trim); return; }
  const deco = crown === 'deco' || (!crown && (v.facadePattern === 'artDeco' || v.facadePattern === 'artDecoCrown'));
  band(e, v, z - m(.2), deco ? m(.55) : CORNICE_OUT, deco ? m(.55) : m(.36), trim);
  if (deco) band(e, v, z - m(1.05), m(.28), m(.32), trim);
}

/** User-placed details follow the mass and rest on its actual roof surface. */
function emitRoofDetails(e: Emitter, b: Building, v: Volume, floor: number): void {
  const base = floor + volumeHeight(b, v);
  const metal = paint({ finish: 'metal', colour: 0x677b79 });
  const panel = paint({ finish: 'glass', colour: 0x153e4c });
  const glazing = paint({ finish: 'glass', colour: 0x6098a6 });
  const masonry = paint({ finish: 'brick', colour: 0x876755 });
  const concrete = paint({ finish: 'concrete', colour: 0xaaa99d });
  for (const detail of v.roofDetails ?? []) {
    const z = base + roofHeightAt(b, v, detail);
    if (detail.kind === 'solar' || detail.kind === 'skylight') {
      const c = Math.cos(detail.rotation), s = Math.sin(detail.rotation);
      const point = (x: number, y: number, lift: number): V3 => {
        const px = detail.x + x * c - y * s, py = detail.y + x * s + y * c;
        return e.L(px, py, base + roofHeightAt(b, v, { x: px, y: py }) + lift);
      };
      const quad = (grow: number, lift: number): V3[] => [
        point(-detail.w / 2 - grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, -detail.d / 2 - grow, lift),
        point(detail.w / 2 + grow, detail.d / 2 + grow, lift),
        point(-detail.w / 2 - grow, detail.d / 2 + grow, lift),
      ];
      e.shell.face(quad(0.15, 0.18), [0, 0, 1], metal);
      e.shell.face(quad(0, 0.24), [0, 0, 1], detail.kind === 'solar' ? panel : glazing);
      continue;
    }
    if (detail.kind === 'vent') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(1), metal);
    } else if (detail.kind === 'spire') {
      const height = detail.h ?? m(11.7);
      const radius = Math.min(detail.w, detail.d) * 0.47;
      const baseStone = paint({ finish: 'plaster', colour: 0xd1ccbe });
      e.box(detail.x - radius, detail.y - radius, detail.x + radius, detail.y + radius, z - m(0.15), z + m(0.75), baseStone);
      const rings = [
        { z: z + m(0.75), r: radius * .78 },
        { z: z + height * .28, r: radius * .48 },
        { z: z + height * .84, r: radius * .12 },
        { z: z + height, r: Math.max(m(0.025), radius * .025) },
      ];
      for (let band = 0; band < rings.length - 1; band++) {
        const lo = rings[band]!, hi = rings[band + 1]!;
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4, c = (i + 1) * Math.PI / 4;
          const point = (angle: number, r: number, h: number): V3 =>
            e.L(detail.x + Math.cos(angle) * r, detail.y + Math.sin(angle) * r, h);
          e.shell.face([point(a, lo.r, lo.z), point(c, lo.r, lo.z), point(c, hi.r, hi.z), point(a, hi.r, hi.z)],
            e.N(Math.cos((a + c) / 2), Math.sin((a + c) / 2)), band === 0 ? baseStone : metal);
        }
      }
      const design = flagOf(detail);
      if (design) emitFlag(e, detail.x, detail.y, z + height * .98, design, m(2.2), m(1.25));
    } else if (detail.kind === 'lantern') {
      emitLantern(e, detail, z);
    } else if (detail.kind === 'chimney') {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - 0.2, z + m(2.1), masonry);
      e.box(detail.x - detail.w / 2 - .1, detail.y - detail.d / 2 - .1,
        detail.x + detail.w / 2 + .1, detail.y + detail.d / 2 + .1, z + m(2.1), z + m(2.25), concrete);
    } else {
      e.box(detail.x - detail.w / 2, detail.y - detail.d / 2,
        detail.x + detail.w / 2, detail.y + detail.d / 2, z - .1, z + m(1.6), metal);
    }
  }
}


/** A flag flown from a mast whose top is at (x, y, flagTop) */
function emitFlag(e: Emitter, x: number, y: number, flagTop: number, design: FlagDesign, width: number, height: number): void {
  if (!flagSink) return;
  const [wx, wy, wz] = e.L(x, y, flagTop);
  flagSink.push({ x: wx, y: wz, z: -wy, width, height, design });
}

/** The lighthouse on a tower top, measured on the Altino Arantes model */
function emitLantern(e: Emitter, detail: RoofDetail, z: number): void {
  const h = detail.h ?? m(19.4);
  const k = h / m(19.4);
  const span = Math.min(detail.w, detail.d);
  const stone = paint({ finish: 'stone', colour: 0xc9c6bd });
  const render = paint({ finish: 'plaster', colour: 0xe4e1d8 });
  const glass = paint({ finish: 'glass', colour: 0x7fa8b8 });
  const frame = paint({ finish: 'plaster', colour: 0xf0eee8 });
  const dome = paint({ finish: 'metal', colour: 0xcbb99a });
  const mast = paint({ finish: 'metal', colour: 0x8e9396 });
  const red = paint({ finish: 'plaster', colour: 0xe0301e });
  const N = 24;
  const at = (ang: number, rr: number, zz: number): V3 => e.L(detail.x + Math.cos(ang) * rr, detail.y + Math.sin(ang) * rr, zz);
  /** A ring of `n` faces between radii and heights (n = 8: octagon, 24: a cylinder). */
  const ring = (n: number, z0: number, z1: number, r0: number, r1: number, c: Paint, turn = 0): void => {
    for (let i = 0; i < n; i++) {
      const p0 = turn + (i * 2 * Math.PI) / n, p1 = turn + ((i + 1) * 2 * Math.PI) / n;
      e.shell.face([at(p0, r0, z0), at(p1, r0, z0), at(p1, r1, z1), at(p0, r1, z1)], e.N(Math.cos((p0 + p1) / 2), Math.sin((p0 + p1) / 2)), c);
    }
  };
  const disc = (n: number, zz: number, rr: number, c: Paint, turn = 0): void => {
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) pts.push(at(turn + (i * 2 * Math.PI) / n, rr, zz));
    e.shell.face(pts, [0, 0, 1], c);
  };
  // The octagonal base, 1.0 m.
  const rBase = span / 2;
  const z1 = z + m(1.03) * k;
  ring(8, z - m(0.05), z1, rBase, rBase, stone, Math.PI / 8);
  disc(8, z1, rBase, stone, Math.PI / 8);
  // The glazed cylinder, 3.7 m across, 7.5 m tall: glass, then the grid in front of it
  const rCyl = rBase * (3.69 / 4.02);
  const z2 = z1 + m(7.47) * k;
  ring(N, z1, z2, rCyl, rCyl, glass);
  // The model's grid: a band at every 1.5 m, a mullion every 15 degrees.
  const floors = 5;
  for (let f = 0; f <= floors; f++) {
    const zz = z1 + ((z2 - z1) * f) / floors;
    ring(N, Math.max(z1, zz - m(0.07)), Math.min(z2, zz + m(0.07)), rCyl + m(0.04), rCyl + m(0.04), frame);
  }
  for (let i = 0; i < 24; i++) {
    const ang = (i * 2 * Math.PI) / 24;
    const cx = detail.x + Math.cos(ang) * (rCyl + m(0.02)), cy = detail.y + Math.sin(ang) * (rCyl + m(0.02)), s = m(0.035);
    e.box(cx - s, cy - s, cx + s, cy + s, z1, z2, frame);
  }
  ring(N, z2 - m(0.05), z2 + m(0.25), rCyl + m(0.12), rCyl + m(0.12), render);
  disc(N, z2 + m(0.25), rCyl + m(0.12), render);
  // The hemispherical dome, 1.1 m.
  const zDome = z2 + m(0.25);
  const hDome = m(1.1) * k;
  const steps = 6;
  for (let s = 0; s < steps; s++) {
    const a0 = (s / steps) * Math.PI / 2, a1 = ((s + 1) / steps) * Math.PI / 2;
    ring(N, zDome + Math.sin(a0) * hDome, zDome + Math.sin(a1) * hDome, rCyl * Math.cos(a0), Math.max(m(0.16), rCyl * Math.cos(a1)), dome);
  }
  // The mast, 0.3 m, to the top; the aviation light under its tip.
  const top = z + h;
  ring(8, zDome + hDome - m(0.05), top, m(0.15), m(0.1), mast);
  e.box(detail.x - m(0.2), detail.y - m(0.2), detail.x + m(0.2), detail.y + m(0.2), top - m(0.45), top - m(0.1), red);
  // The flag: 6.6 x 4.3 m on the model's 19.4 m lighthouse.
  const design = flagOf(detail);
  if (design) emitFlag(e, detail.x, detail.y, top - m(0.5), design, h * 0.34, h * 0.34 * 0.65);
}

/** Cut a pitched roof into planar regions, then clip each region to any outline. */
function emitPolygonRoof(
  e: Emitter, b: Building, v: Volume, floor: number,
  wallOf: (side: FaceId) => Paint, trim: Paint, roofColour: Paint,
): void {
  const z = floor + volumeHeight(b, v);
  const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
  const slope = roofSlope(v);
  type Patch = { ring: Vec2[]; height: (p: Vec2) => number };
  const rect = (a: number, c: number, d: number, f: number): Vec2[] =>
    [{ x: a, y: c }, { x: d, y: c }, { x: d, y: f }, { x: a, y: f }];
  let patches: Patch[] = [];
  if (v.roof === 'flat' || v.roof === 'terrace') {
    patches = [{ ring: rect(x0, y0, x1, y1), height: () => 0 }];
  } else if (v.roof === 'gable') {
    if (ridgeAlongX(v)) {
      const mid = (y0 + y1) / 2;
      patches = [
        { ring: rect(x0, y0, x1, mid), height: (p) => (p.y - y0) * slope },
        { ring: rect(x0, mid, x1, y1), height: (p) => (y1 - p.y) * slope },
      ];
    } else {
      const mid = (x0 + x1) / 2;
      patches = [
        { ring: rect(x0, y0, mid, y1), height: (p) => (p.x - x0) * slope },
        { ring: rect(mid, y0, x1, y1), height: (p) => (x1 - p.x) * slope },
      ];
    }
  } else if (v.roof === 'hip') {
    const alongX = v.w >= v.d;
    const long = alongX ? v.w : v.d, short = alongX ? v.d : v.w;
    const h = short / 2;
    const P = (u: number, a: number): Vec2 => alongX ? { x: x0 + u, y: y0 + a } : { x: x0 + a, y: y0 + u };
    const polygon = (pairs: readonly (readonly [number, number])[]): Vec2[] => pairs.map(([u, a]) => P(u, a));
    const U = (p: Vec2): number => alongX ? p.x - x0 : p.y - y0;
    const A = (p: Vec2): number => alongX ? p.y - y0 : p.x - x0;
    patches = [
      { ring: polygon([[0, 0], [h, h], [0, short]]), height: (p) => U(p) * slope },
      { ring: polygon([[long, 0], [long, short], [long - h, h]]), height: (p) => (long - U(p)) * slope },
      { ring: polygon([[0, 0], [long, 0], [long - h, h], [h, h]]), height: (p) => A(p) * slope },
      { ring: polygon([[h, h], [long - h, h], [long, short], [0, short]]), height: (p) => (short - A(p)) * slope },
    ];
  } else if (v.roof === 'shed') {
    const fall = shedFall(v);
    patches = [{ ring: rect(x0, y0, x1, y1), height: (p) =>
      (fall === 0 ? p.y - y0 : fall === 2 ? y1 - p.y : fall === 1 ? x1 - p.x : p.x - x0) * slope }];
  } else {
    const run = sawtoothRun(b, v);
    for (let from = y0; from < y1 - 1e-6; from += run) {
      const to = Math.min(y1, from + run), middle = (from + to) / 2;
      patches.push({ ring: rect(x0, from, x1, middle), height: (p) => (p.y - from) * slope });
      patches.push({ ring: rect(x0, middle, x1, to), height: (p) => (to - p.y) * slope });
    }
  }
  const footprint = asPolygon(localFootprint(v));
  const heightAt = (p: Vec2): number => roofHeightAt(b, v, p);
  const roofPaint = v.roof === 'terrace' ? TERRACE : roofColour;
  for (const patch of patches) {
    const pieces = clipping.intersection(footprint, asPolygon(patch.ring));
    for (const piece of pieces) {
      const ring = piece[0];
      if (!ring || ring.length < 4) continue;
      const flat = ring.slice(0, -1).flat();
      const triangles = earcut(flat);
      for (let i = 0; i < triangles.length; i += 3) {
        const plan = [triangles[i], triangles[i + 1], triangles[i + 2]].map((index) =>
          ({ x: flat[2 * index!]!, y: flat[2 * index! + 1]! }));
        const a = plan[0]!, c = plan[1]!, d = plan[2]!;
        const az = patch.height(a), cz = patch.height(c), dz = patch.height(d);
        const ux = c.x - a.x, uy = c.y - a.y, uz = cz - az;
        const vx = d.x - a.x, vy = d.y - a.y, vz = dz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const length = Math.hypot(nx, ny, nz) || 1;
        e.shell.face([e.L(a.x, a.y, z + az), e.L(c.x, c.y, z + cz), e.L(d.x, d.y, z + dz)],
          e.N(nx / length, ny / length, nz / length), roofPaint);
      }
    }
  }
  // The eaves close under pitched surfaces. Short segments follow every break.
  for (const side of volumeSides(v)) {
    const frame = edgeFrame(v, side);
    const divisions = Math.max(1, Math.ceil(frame.length / b.module));
    for (let i = 0; i < divisions; i++) {
      const a0 = i * frame.length / divisions, a1 = (i + 1) * frame.length / divisions;
      const p0 = { x: frame.x + frame.tx * a0, y: frame.y + frame.ty * a0 };
      const p1 = { x: frame.x + frame.tx * a1, y: frame.y + frame.ty * a1 };
      const h0 = Math.max(0, heightAt(p0)), h1 = Math.max(0, heightAt(p1));
      if (h0 + h1 > 1e-4) e.shell.face([e.L(p0.x, p0.y, z), e.L(p1.x, p1.y, z), e.L(p1.x, p1.y, z + h1), e.L(p0.x, p0.y, z + h0)], e.N(frame.nx, frame.ny), wallOf(side));
    }
    // A low continuous coping makes the plan legible at game zoom.
    const f: BayFace = { ...sideFrame(v, side, 0), z0: z, W: frame.length, H: PARAPET_H };
    if (v.roof === 'flat' || v.roof === 'terrace') {
      if (v.roof === 'terrace') e.put('roofRailing', f, frame.length / 2, 0, m(.12), frame.length, m(1), 1);
      else {
        // A wall with two faces and a top, as the square blocks' parapets (\`emitRoof\`)
        const out = e.N(f.nx, f.ny);
        e.rect(f, 0, frame.length, 0, PARAPET_H, 0, out, wallOf(side));
        e.rect(f, 0, frame.length, 0, PARAPET_H, PARAPET_T, [-out[0], -out[1], 0], shaded(roofColour, 0.9));
        e.strip(f, 0, frame.length, PARAPET_H, -m(0.05), PARAPET_T + m(0.05), [0, 0, 1], copingOf(trim));
      }
    }
  }
  if (v.roof === 'flat' || v.roof === 'terrace') emitCornice(e, v, z, trim);
  if (v.roof === 'flat') emitRoofPlant(e, b, v, z, trim);
}


function emitRoof(
  e: Emitter,
  b: Building,
  v: Volume,
  floor: number,
  wallOf: (side: FaceId) => Paint,
  trim: Paint,
  roofColour: Paint,
): void {
  if (v.outline) { emitPolygonRoof(e, b, v, floor, wallOf, trim, roofColour); return; }
  const top = volumeTop(v);
  const z = floor + volumeHeight(b, v);
  const x0 = v.x;
  const y0 = v.y;
  const x1 = v.x + v.w;
  const y1 = v.y + v.d;
  const sh = e.shell;
  const up: V3 = [0, 0, 1];

  if (v.roof === 'flat' || v.roof === 'terrace') {
    const terrace = v.roof === 'terrace';
    sh.face([e.L(x0, y0, z), e.L(x1, y0, z), e.L(x1, y1, z), e.L(x0, y1, z)], up, terrace ? TERRACE : roofColour);
    // A terrace with a block standing on it (a setback, a tower's podium) is left plain
    const built = b.volumes.some((o) => o !== v && !o.open && o.base === top);
    if (!terrace) emitRoofPlant(e, b, v, z, trim);
    else if (!built) emitTerrace(e, b, v, z, trim);
    // Its top stays just under the roof: a face shared with the roof cap z-fights into stripes.
    emitCornice(e, v, z, trim);
    // An edge bay gets a parapet (or a railing, on a terrace) only where the roof really ends
    for (const side of volumeSides(v)) {
      // Only where the roof really ends: not against a neighbour as tall or taller.
      const spans = [...coveredSpans(b, v, side, top - 1), ...coveredSpans(b, v, side, top)].sort((p, q) => p[0] - q[0]);
      const step = bayWidth(b, v, side);
      for (const [p0, p1] of exposedParts(spans, 0, sideLength(v, side))) {
        // In bay-sized pieces, so a railing keeps its baluster spacing.
        const pieces = Math.max(1, Math.round((p1 - p0) / step));
        const W = (p1 - p0) / pieces;
        for (let k = 0; k < pieces; k++) {
          const ph = v.dress?.crown === 'attic' ? ATTIC_H : PARAPET_H;
          const face: BayFace = { ...sideFrame(v, side, p0 + k * W), z0: z, W, H: ph };
          if (terrace) {
            e.put('roofRailing', face, W / 2, 0, m(0.12), W, m(1.0), 1);
          } else {
            const out = e.N(face.nx, face.ny);
            e.rect(face, 0, W, 0, ph, 0, out, wallOf(side));
            // Its inner face is the roof's membrane carried up the parapet
            e.rect(face, 0, W, 0, ph, PARAPET_T, [-out[0], -out[1], 0], shaded(roofColour, 0.9));
            // The coping: proud of both faces, so the rain drips clear of them.
            const coping = copingOf(trim);
            e.strip(face, 0, W, ph, -m(0.05), PARAPET_T + m(0.05), up, coping);
            e.rect(face, 0, W, ph - m(0.06), ph, -m(0.05), out, shaded(coping, 0.9));
          }
        }
      }
    }
    return;
  }

  const rise = roofRise(b, v);
  const slope = roofSlope(v);
  if (v.roof === 'gable' || v.roof === 'hip') {
    const alongX = ridgeAlongX(v);
    // Work in a frame whose "long" axis runs along the ridge.
    const span = alongX ? y1 - y0 : x1 - x0;
    const eave = z - EAVES * slope;
    const ridge = z + rise;
    const hip = v.roof === 'hip' ? Math.min(span / 2, (alongX ? x1 - x0 : y1 - y0) / 2) : 0;
    const Lp = (along: number, across: number, height: number): V3 =>
      alongX ? e.L(along, across, height) : e.L(across, along, height);
    const a0 = alongX ? x0 : y0;
    const a1 = alongX ? x1 : y1;
    const c0 = alongX ? y0 : x0;
    const c1 = alongX ? y1 : x1;
    const cm = (c0 + c1) / 2;
    const nNear = alongX ? e.N(0, -slope, 1) : e.N(-slope, 0, 1);
    const nFar = alongX ? e.N(0, slope, 1) : e.N(slope, 0, 1);
    const o = EAVES;
    const r0 = a0 + hip;
    const r1 = a1 - hip;
    // The two long slopes.
    sh.face([Lp(a0 - o, c0 - o, eave), Lp(a1 + o, c0 - o, eave), Lp(r1, cm, ridge), Lp(r0, cm, ridge)], nNear, roofColour);
    sh.face([Lp(a1 + o, c1 + o, eave), Lp(a0 - o, c1 + o, eave), Lp(r0, cm, ridge), Lp(r1, cm, ridge)], nFar, roofColour);
    const endLow = alongX ? e.N(-slope, 0, 1) : e.N(0, -slope, 1);
    const endHigh = alongX ? e.N(slope, 0, 1) : e.N(0, slope, 1);
    // The roof has a body, not a sheet of paper (the player's order of 2026-10-05)
    const T = ROOF_THICK;
    const fascia = shaded(trim, 0.92);
    const soffit = shaded(trim, 0.7);
    const outC0 = alongX ? e.N(0, -1) : e.N(-1, 0);
    const outC1 = alongX ? e.N(0, 1) : e.N(1, 0);
    const outA0 = alongX ? e.N(-1, 0) : e.N(0, -1);
    const outA1 = alongX ? e.N(1, 0) : e.N(0, 1);
    const down: V3 = [0, 0, -1];
    sh.face([Lp(a0 - o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave), Lp(a0 - o, c0 - o, eave)], outC0, fascia);
    sh.face([Lp(a1 + o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave), Lp(a1 + o, c1 + o, eave)], outC1, fascia);
    sh.face([Lp(a0 - o, c0 - o, eave - T), Lp(a1 + o, c0 - o, eave - T), Lp(a1, c0, z - T), Lp(a0, c0, z - T)], down, soffit);
    sh.face([Lp(a1 + o, c1 + o, eave - T), Lp(a0 - o, c1 + o, eave - T), Lp(a0, c1, z - T), Lp(a1, c1, z - T)], down, soffit);
    // The ridge cap: a rounded row of tiles, two narrow slopes over the ridge.
    if (r1 > r0) {
      const w = m(0.14), lift = m(0.07);
      sh.face([Lp(r0, cm - w, ridge - w * slope + m(0.01)), Lp(r1, cm - w, ridge - w * slope + m(0.01)), Lp(r1, cm, ridge + lift), Lp(r0, cm, ridge + lift)], nNear, shaded(roofColour, 0.85));
      sh.face([Lp(r1, cm + w, ridge - w * slope + m(0.01)), Lp(r0, cm + w, ridge - w * slope + m(0.01)), Lp(r0, cm, ridge + lift), Lp(r1, cm, ridge + lift)], nFar, shaded(roofColour, 0.85));
    }
    if (v.roof === 'hip') {
      sh.face([Lp(a0 - o, c1 + o, eave), Lp(a0 - o, c0 - o, eave), Lp(r0, cm, ridge)], endLow, roofColour);
      sh.face([Lp(a1 + o, c0 - o, eave), Lp(a1 + o, c1 + o, eave), Lp(r1, cm, ridge)], endHigh, roofColour);
      sh.face([Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c0 - o, eave - T), Lp(a0 - o, c0 - o, eave), Lp(a0 - o, c1 + o, eave)], outA0, fascia);
      sh.face([Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c1 + o, eave - T), Lp(a1 + o, c1 + o, eave), Lp(a1 + o, c0 - o, eave)], outA1, fascia);
      sh.face([Lp(a0 - o, c1 + o, eave - T), Lp(a0 - o, c0 - o, eave - T), Lp(a0, c0, z - T), Lp(a0, c1, z - T)], down, soffit);
      sh.face([Lp(a1 + o, c0 - o, eave - T), Lp(a1 + o, c1 + o, eave - T), Lp(a1, c1, z - T), Lp(a1, c0, z - T)], down, soffit);
    } else {
      // Barge boards: the slab's edge up each rake, and its underside over the gable.
      for (const [a, out] of [[a0 - o, outA0], [a1 + o, outA1]] as const) {
        sh.face([Lp(a, c0 - o, eave - T), Lp(a, cm, ridge - T), Lp(a, cm, ridge), Lp(a, c0 - o, eave)], out, fascia);
        sh.face([Lp(a, cm, ridge - T), Lp(a, c1 + o, eave - T), Lp(a, c1 + o, eave), Lp(a, cm, ridge)], out, fascia);
      }
      for (const [aOut, aIn] of [[a0 - o, a0], [a1 + o, a1]] as const) {
        sh.face([Lp(aOut, c0 - o, eave - T), Lp(aIn, c0 - o, eave - T), Lp(aIn, cm, ridge - T), Lp(aOut, cm, ridge - T)], down, soffit);
        sh.face([Lp(aOut, cm, ridge - T), Lp(aIn, cm, ridge - T), Lp(aIn, c1 + o, eave - T), Lp(aOut, c1 + o, eave - T)], down, soffit);
      }
      // Gable ends: wall-coloured triangles.
      const w0 = alongX ? e.N(-1, 0) : e.N(0, -1);
      const w1 = alongX ? e.N(1, 0) : e.N(0, 1);
      sh.face([Lp(a0, c0, z), Lp(a0, c1, z), Lp(a0, cm, ridge)], w0, wallOf(alongX ? 3 : 0));
      sh.face([Lp(a1, c1, z), Lp(a1, c0, z), Lp(a1, cm, ridge)], w1, wallOf(alongX ? 1 : 2));
    }
    return;
  }

  if (v.roof === 'shed') {
    // One slope, low along the side it falls towards and high along the opposite one.
    const fall = shedFall(v);
    const lowAlongX = fall === 0 || fall === 2;
    const eaveLength = lowAlongX ? x1 - x0 : y1 - y0;
    const run = lowAlongX ? y1 - y0 : x1 - x0;
    const Q = (a: number, t: number, height: number): V3 => {
      switch (fall) {
        case 0: return e.L(x0 + a * (x1 - x0), y0 + t * (y1 - y0), height);
        case 2: return e.L(x0 + a * (x1 - x0), y1 - t * (y1 - y0), height);
        case 3: return e.L(x0 + t * (x1 - x0), y0 + a * (y1 - y0), height);
        default: return e.L(x1 - t * (x1 - x0), y0 + a * (y1 - y0), height);
      }
    };
    const high = z + run * slope;
    const oa = EAVES / eaveLength;
    const ot = EAVES / run;
    const nf = SIDE_NORMAL[fall];
    sh.face(
      [Q(-oa, -ot, z - EAVES * slope), Q(1 + oa, -ot, z - EAVES * slope), Q(1 + oa, 1 + ot, high + EAVES * slope), Q(-oa, 1 + ot, high + EAVES * slope)],
      e.N(nf.x * slope, nf.y * slope, 1),
      roofColour,
    );
    // The slab's body: a fascia on all four edges and the soffit under the overhang, so the roof has a thickness
    {
      const T = ROOF_THICK;
      const lo = z - EAVES * slope, hi = high + EAVES * slope;
      const fasc = shaded(trim, 0.92), soff = shaded(trim, 0.7);
      const pts = [Q(-oa, -ot, lo), Q(1 + oa, -ot, lo), Q(1 + oa, 1 + ot, hi), Q(-oa, 1 + ot, hi)];
      for (let k = 0; k < 4; k++) {
        const p0 = pts[k]!, p1 = pts[(k + 1) % 4]!;
        const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
        const len = Math.hypot(ex, ey) || 1;
        // Outward for the corner order (counter-clockwise in plan or not, the face winding is measured).
        const cx = (pts[0]![0] + pts[2]![0]) / 2, cy = (pts[0]![1] + pts[2]![1]) / 2;
        let nx = ey / len, ny = -ex / len;
        if ((p0[0] - cx) * nx + (p0[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
        sh.face([[p0[0], p0[1], p0[2] - T], [p1[0], p1[1], p1[2] - T], p1, p0], [nx, ny, 0], fasc);
      }
      sh.face([Q(-oa, -ot, lo - T), Q(1 + oa, -ot, lo - T), Q(1 + oa, 1 + ot, hi - T), Q(-oa, 1 + ot, hi - T)], [0, 0, -1], soff);
    }
    // The two end walls, rising with the slope, and the tall wall at the back.
    const back = ((fall + 2) % 4) as Side;
    const ends = SIDES.filter((x) => x !== fall && x !== back);
    for (const end of ends) {
      const a = (lowAlongX ? end === 3 : end === 0) ? 0 : 1;
      const n = SIDE_NORMAL[end];
      sh.face([Q(a, 0, z), Q(a, 1, z), Q(a, 1, high)], e.N(n.x, n.y), wallOf(end));
    }
    const nb = SIDE_NORMAL[back];
    sh.face([Q(0, 1, z), Q(1, 1, z), Q(1, 1, high), Q(0, 1, high)], e.N(nb.x, nb.y), wallOf(back));
    return;
  }

  // Sawtooth: teeth of up to two cells, glazed on their steep face.
  const tooth = sawtoothRun(b, v);
  const toothRise = tooth * 0.5 * slope;
  const glass = SAW_GLASS;
  for (let t0 = y0; t0 < y1 - 1e-6; t0 += tooth) {
    const t1 = Math.min(y1, t0 + tooth);
    const h = toothRise * ((t1 - t0) / tooth);
    sh.face([e.L(x0, t0, z), e.L(x1, t0, z), e.L(x1, t1, z + h), e.L(x0, t1, z + h)], e.N(0, -1, 2), roofColour);
    sh.face([e.L(x1, t1, z), e.L(x0, t1, z), e.L(x0, t1, z + h), e.L(x1, t1, z + h)], e.N(0, 1), glass);
    sh.face([e.L(x0, t0, z), e.L(x0, t1, z), e.L(x0, t1, z + h)], e.N(-1, 0), wallOf(3));
    sh.face([e.L(x1, t1, z), e.L(x1, t0, z), e.L(x1, t1, z + h)], e.N(1, 0), wallOf(1));
  }
}

// ------------------------------------------------------------------ chunks

/** The rooms behind a batch of panes, ROOM_FLOATS a pane; zeros (no room) where none is known. */
function roomsOfPanes(list: readonly Placement[]): Float32Array {
  const out = new Float32Array(list.length * ROOM_FLOATS);
  list.forEach((p, i) => { if (p.room) out.set(p.room, i * ROOM_FLOATS); });
  return out;
}

/** Column-major T * Ry * S, written straight into `out` at `offset`. */
function writeMatrix(out: Float32Array, offset: number, p: Placement): void {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  out[offset] = c * p.sx; out[offset + 1] = 0; out[offset + 2] = -s * p.sx; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = p.sy; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s * p.sz; out[offset + 9] = 0; out[offset + 10] = c * p.sz; out[offset + 11] = 0;
  // World y is mirrored into three's z, as everywhere else in this layer.
  out[offset + 12] = p.x; out[offset + 13] = p.z; out[offset + 14] = -p.y; out[offset + 15] = 1;
}

/** Whether a building flies a flag: a spire or a lantern on its roof with a flag (`flagOf`). */
export function fliesFlag(b: Building): boolean {
  return b.volumes.some((v) => (v.roofDetails ?? []).some((d) => (d.kind === 'spire' || d.kind === 'lantern') && flagOf(d) !== null));
}

/** A signature building's ground floor (`BuildingChunk.signatureFloor`) without emitting it */
export function signatureFloorOf(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  if (!drawsSignature(b)) return undefined;
  const resolved = resolveBlocks(b);
  return resolved.volumes.some((v) => !v.open) ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** A wear as the shell's vertices carry it to the GPU: a signed short over 32767 (`cellArrays.ts` `normalDecay`). */
const wearShort = (x: number): number => snorm16(x) / NORMAL_UNIT;

/** `far`: the building's far level (L1) - walls as runs of bays with their windows drawn by the shader, no parts (`facadeLevel.ts`). */
/** `apart`: the elements' boxes, pavings and rails as instances of the shell's parts (`shellParts.ts`); false lays them in the shell face by face, as the parts draw them (the specs compare). */
/** `party`: the job's buildings as one another's neighbours (`partyWalls.ts`): the bays inside a neighbour are not laid, and each floor is worked out once. */
export function emitChunk(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, slots: SlotAllocator = spaceSeed, far = false, apart = true,
  party?: PartyWalls): BuildingChunk {
  const shell = new Shell();
  shell.decay = b.decay ?? 0;
  shell.far = far;
  shell.apart = apart;
  const parts = Object.fromEntries(PART_KINDS.map((k) => [k, [] as Placement[]])) as Record<PartKind, Placement[]>;
  // The blocks as drawn: unions, cuts and intersections resolved, the stored blocks untouched (`world/buildings/blocks.ts`).
  const resolved = resolveBlocks(b);
  // Open blocks are lots: laid on the ground, not built.
  const lots = resolved.volumes.filter((v) => v.open);
  // One list for the blocks: their bays laid out and their floors furnished once (`bayLayout`, `interiorAt`) for every reader and like building.
  const closed = closedBlocks(resolved.volumes);
  const furnished: Partial<Record<FurnitureKind, Placement[]>> = {};
  const inLot = (el: BuildingElement): boolean =>
    lots.some((v) => el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
  // The terrain is graded from this natural-ground floor.
  const designedFloor = party ? party.floorOf(b) : closed.length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
  const flags: FlagInstance[] = [];
  flagSink = flags;
  // A signature building's body is drawn with its own parts (`signature.ts`).
  const signature = closed.length > 0 && drawsSignature(b);
  const body = !signature && closed.length > 0
    ? emitBuilding({ ...resolved, volumes: closed }, groundAt, shell, parts, pavedAt, furnished, inLot, designedFloor, slots, party?.coversNear(b))
    : undefined;
  const floor = signature ? designedFloor : body?.floor;
  flagSink = null;
  const lotGround = emitLots(resolved, lots, closed.length === 0, groundAt, shell, parts, floor, pavedAt, inLot, body?.entrances);
  const batches = {} as Record<PartKind, PartBatch>;
  for (const kind of PART_KINDS) {
    const list = parts[kind];
    const matrices = new Float32Array(list.length * 16);
    const coloured = COLOURED_PARTS.has(kind);
    const colours = coloured ? new Float32Array(list.length * 3) : null;
    const fallback = PART_DEFAULT_COLOUR[kind] ?? WHITE_RGB;
    // A shell's part: its finish, its wear as the shell's vertices carry it and its ground (none: `NO_GROUND`).
    const looks = SHELL_PARTS.has(kind) ? new Float32Array(list.length * LOOK_FLOATS) : null;
    list.forEach((p, i) => {
      writeMatrix(matrices, i * 16, p);
      if (colours) {
        const rgb = p.look?.paint.rgb;
        colours[i * 3] = rgb ? rgb[0] : p.colour ? p.colour.r : fallback[0];
        colours[i * 3 + 1] = rgb ? rgb[1] : p.colour ? p.colour.g : fallback[1];
        colours[i * 3 + 2] = rgb ? rgb[2] : p.colour ? p.colour.b : fallback[2];
      }
      if (looks && p.look) {
        looks[i * LOOK_FLOATS] = finishId(p.look.paint.finish);
        looks[i * LOOK_FLOATS + 1] = wearShort(p.look.decay);
        looks[i * LOOK_FLOATS + 2] = Number.isFinite(p.look.ground) ? p.look.ground : NO_GROUND;
      }
    });
    const glassy = kind === 'glass' || kind === 'glassDark';
    batches[kind] = glassy
      ? { matrices, colours, count: list.length, slots: Float32Array.from(list, (p) => p.slot ?? -1), rooms: roomsOfPanes(list) }
      : looks ? { matrices, colours, count: list.length, looks } : { matrices, colours, count: list.length };
  }
  const shells = shellChunks(shell);
  let furniture: Partial<Record<FurnitureKind, PartBatch>> | undefined;
  for (const kind of FURNITURE_KINDS) {
    const list = furnished[kind];
    if (!list || list.length === 0) continue;
    const matrices = new Float32Array(list.length * 16);
    list.forEach((p, i) => writeMatrix(matrices, i * 16, p));
    (furniture ??= {})[kind] = { matrices, colours: null, count: list.length };
  }
  const runs = runChunks(shell);
  const laid = runs ? { shells, runs } : { shells };
  const out = furniture ? { ...laid, parts: batches, furniture } : { ...laid, parts: batches };
  const withGround = lotGround ? { ...out, lotGround } : out;
  const withSignature = signature && floor !== undefined ? { ...withGround, signatureFloor: floor } : withGround;
  return flags.length ? { ...withSignature, flags } : withSignature;
}

/** A part's arrays viewed at their length, no copy. */
const shellChunkOf = (part: ShellPart): ShellChunk =>
  ({ position: part.position.view(), normalDecay: part.normalDecay.view(), paint: part.paint.view(), index: part.index.view() });

/** A shell's fragments by finish: the arrays it was laid in (every face but the far level's runs with openings). */
function shellChunks(shell: Shell): Partial<Record<Finish, ShellChunk>> {
  const shells: Partial<Record<Finish, ShellChunk>> = {};
  for (const [finish, part] of shell.parts) if (part.index.length > 0) shells[finish] = shellChunkOf(part);
  return shells;
}

/** The far level's runs of bays with openings by finish, each vertex with its window grid; undefined when none was laid. */
function runChunks(shell: Shell): Partial<Record<Finish, RunChunk>> | undefined {
  let runs: Partial<Record<Finish, RunChunk>> | undefined;
  for (const [finish, part] of shell.runs) {
    if (part.index.length === 0 || !part.facade || !part.grid || !part.opening) continue;
    (runs ??= {})[finish] = { ...shellChunkOf(part), facade: part.facade.view(), grid: part.grid.view(), opening: part.opening.view() };
  }
  return runs;
}

/** The shell's parts of a chunk laid as the shell's faces again, as `Emitter.box`, `slab` and `emitFence` laid them, from the instances alone (`shellParts.ts`) */
export function shellPartFaces(parts: Readonly<Record<PartKind, PartBatch>>): Partial<Record<Finish, ShellChunk>> {
  const shell = new Shell();
  for (const kind of SHELL_PART_KINDS) {
    const batch = parts[kind];
    if (!batch?.count || !batch.looks || !batch.colours) continue;
    const { matrices: e, colours, looks } = batch;
    for (let i = 0; i < batch.count; i++) {
      const o = i * 16;
      const sx = Math.hypot(e[o]!, e[o + 1]!, e[o + 2]!), sz = Math.hypot(e[o + 8]!, e[o + 9]!, e[o + 10]!);
      // A model point (three's axes) through the matrix, then into the map's (x, y north, z up).
      const at = (x: number, y: number, z: number, w: number): V3 => {
        const X = e[o]! * x + e[o + 4]! * y + e[o + 8]! * z + e[o + 12]! * w;
        const Y = e[o + 1]! * x + e[o + 5]! * y + e[o + 9]! * z + e[o + 13]! * w;
        const Z = e[o + 2]! * x + e[o + 6]! * y + e[o + 10]! * z + e[o + 14]! * w;
        return [X, -Z, Y];
      };
      const ground = looks[i * LOOK_FLOATS + 2]!;
      shell.decay = looks[i * LOOK_FLOATS + 1]!;
      shell.ground = ground > NO_GROUND / 2 ? ground : Number.NaN;
      const paint: Paint = { rgb: [colours[i * 3]!, colours[i * 3 + 1]!, colours[i * 3 + 2]!], finish: FINISHES[looks[i * LOOK_FLOATS]!]! };
      for (const f of SHELL_PART_FACES[kind]) {
        const points = f.points.map(([u, v, w]): V3 => {
          // A paving's side stands in from its top's edge by `COVER_INSET`, whatever its size.
          const x = f.inset ? Math.sign(u) * Math.max(0.5 - COVER_INSET / sx, 0) : u;
          const z = f.inset ? Math.sign(-v) * Math.max(0.5 - COVER_INSET / sz, 0) : -v;
          return at(x, w, z, 1);
        });
        shell.face(points, at(f.n[0], f.n[2], -f.n[1], 0), paint);
      }
    }
  }
  return shellChunks(shell);
}

/** A chunk with its shell's parts laid in its shell again (`shellPartFaces`): what a ruin breaks (`destruction.ts`), and what the specs compare with the shell as it was. */
export function withShellParts(chunk: BuildingChunk): BuildingChunk {
  const laid = shellPartFaces(chunk.parts);
  const shells: Partial<Record<Finish, ShellChunk>> = { ...chunk.shells };
  for (const [finish, add] of Object.entries(laid) as [Finish, ShellChunk][]) {
    const was = shells[finish];
    if (!was) { shells[finish] = add; continue; }
    const base = was.position.length / 3;
    // `b` after `a` (a part's faces are never a run of bays: the runs stay as they were).
    const joined = <T extends Float32Array | Int16Array | Uint16Array>(a: T, b: T, make: (n: number) => T): T => {
      const out = make(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    const index = new Uint32Array(was.index.length + add.index.length);
    index.set(was.index);
    for (let k = 0; k < add.index.length; k++) index[was.index.length + k] = add.index[k]! + base;
    shells[finish] = {
      position: joined(was.position, add.position, (n) => new Float32Array(n)),
      normalDecay: joined(was.normalDecay, add.normalDecay, (n) => new Int16Array(n)),
      paint: joined(was.paint, add.paint, (n) => new Uint16Array(n)),
      index,
    };
  }
  const none: PartBatch = { matrices: new Float32Array(0), colours: new Float32Array(0), count: 0, looks: new Float32Array(0) };
  const parts = { ...chunk.parts } as Record<PartKind, PartBatch>;
  for (const kind of SHELL_PART_KINDS) parts[kind] = none;
  return { ...chunk, shells, parts };
}

/** Each part's and piece of furniture's geometry box as the kit draws them (`cellArrays.ts` works the batches' bounds from them). */
const KIT_BOXES = new WeakMap<BuildingKit, KitBoxes>();
/** @rebuild Worked out once per kit; every later ask returns the boxes kept. */
export function kitBoxes(kit: BuildingKit): KitBoxes {
  let boxes = KIT_BOXES.get(kit);
  if (!boxes) {
    const boxOf = (g: BufferGeometry): number[] => {
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    };
    const furniture = kit.furniture();
    boxes = {
      parts: Object.fromEntries(PART_KINDS.map((kind) => [kind, boxOf(kit.geometry[kind])])) as Record<PartKind, number[]>,
      furniture: Object.fromEntries(FURNITURE_KINDS.map((kind) => [kind, boxOf(furniture.geometry[kind])])) as Record<FurnitureKind, number[]>,
    };
    KIT_BOXES.set(kit, boxes);
  }
  return boxes;
}

/** What a batch takes by default: every part, the shells and the furniture. */
const WHOLE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS, shells: true, furniture: true };

/** Meshes for a set of building chunks: one merged shell, one instanced batch per part. */
export function assembleBuildingMeshes(
  chunks: readonly BuildingChunk[],
  kit: BuildingKit,
  ghost = false,
  dim = false,
  selection?: AssemblySelection,
): BuildingMeshes {
  const take: CellSelection = { ...WHOLE, ...(selection ? { parts: [...selection.parts], shells: selection.shells, furniture: selection.furniture } : {}), ghost, dim };
  // A lost and restored WebGL context fills the meshes again from the chunks (`gpuOnly.ts`).
  return meshesOf(cellArrays(chunks, take, kitBoxes(kit)), kit, ghost, dim, () => cellArrays(chunks, take, kitBoxes(kit)));
}

/** A batch's meshes from its arrays (`cellArrays.ts`), made here or in a worker */
export function meshesOf(arrays: CellArrays, kit: BuildingKit, ghost: boolean, dim: boolean, refill?: () => CellArrays): BuildingMeshes {
  const group = new Group();
  group.name = ghost ? 'building-preview' : 'buildings';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  const meshes: (Mesh | InstancedMesh)[] = [];
  let triangles = 0;

  // A restored context refills every piece from one batch made again, not one per piece (`gpuOnly.ts` `refillArrays` runs them in one go).
  let again: CellArrays | null = null;
  const refilled = (): CellArrays | null => {
    if (!again && refill) {
      again = refill();
      queueMicrotask(() => { again = null; });
    }
    return again;
  };
  // Every finish of a piece in one geometry, one draw: each vertex's finish picks its layer of the maps (`finishes.ts`).
  arrays.shells.forEach((shell, piece) => {
    const g = new BufferGeometry();
    // DO NOT wrap them in a Float32BufferAttribute or Uint32BufferAttribute: those copy the array they are given
    g.setAttribute('position', new BufferAttribute(shell.position, 3));
    // Four signed shorts a vertex, read as the normal (its fourth left over: no 3-short format in Direct3D 11) and as the wear.
    const normalDecay = new InterleavedBuffer(shell.normalDecay, SHELL_SHORTS);
    g.setAttribute('normal', new InterleavedBufferAttribute(normalDecay, 4, 0, true));
    g.setAttribute('aDecay', new InterleavedBufferAttribute(normalDecay, 1, 3, true));
    // Four unsigned shorts, normalised: the paint and the finish id; the uv is the shader's (`finishes.ts`).
    g.setAttribute(PAINT_ATTRIBUTE, new BufferAttribute(shell.paint, 4, true));
    // The far level's window grid and openings, for its shader (`facadeLevel.ts`).
    const opening = shell.opening ? new InterleavedBuffer(shell.opening, FACADE_BYTES) : null;
    let far: { facade: BufferAttribute; grid: BufferAttribute; opening: InterleavedBuffer } | null = null;
    if (shell.facade && shell.grid && opening) {
      far = { facade: new BufferAttribute(shell.facade, FACADE_FLOATS), grid: new BufferAttribute(shell.grid, FACADE_GRID), opening };
      g.setAttribute('facadeSize', far.facade);
      g.setAttribute('facadeCell', far.grid);
      g.setAttribute('facadeOpening', new InterleavedBufferAttribute(opening, 4, 0, true));
      g.setAttribute('facadeTrim', new InterleavedBufferAttribute(opening, 4, 4, true));
    }
    g.setIndex(new BufferAttribute(shell.index, 1));
    // One Mesh a piece, its arrays let go once on the GPU (below).
    g.boundingBox = boxOf(shell.bounds);
    g.boundingSphere = sphereOf(shell.bounds);
    const mesh = new Mesh(g, ghost ? kit.ghostShell : dim ? kit.dimShell : far ? kit.facade : kit.shellMaterial);
    // The town's shells live on the GPU only: their arrays are let go once uploaded
    if (!ghost) {
      const kept = {
        position: g.attributes.position as BufferAttribute, normalDecay, paint: g.attributes[PAINT_ATTRIBUTE] as BufferAttribute, index: g.index!, ...(far ?? {}),
      };
      gpuOnlyAttributes(mesh, kept, () => {
        // The same chunks make the same pieces in the same order.
        const same = refilled()?.shells[piece];
        return same ? {
          position: same.position, normalDecay: same.normalDecay, paint: same.paint, index: same.index,
          ...(same.facade && same.grid && same.opening ? { facade: same.facade, grid: same.grid, opening: same.opening } : {}),
        } : {};
      });
    }
    mesh.name = ghost ? 'building-preview-shell' : SHELL_MESH;
    mesh.castShadow = !ghost;
    mesh.receiveShadow = !ghost;
    meshes.push(mesh);
    triangles += shell.index.length / 3;
  });

  for (const kind of PART_KINDS) {
    const part = arrays.parts[kind];
    if (!part) continue;
    const { count } = part;
    // Window panes carry their room's light slot, per instance, on their own copy of the pane geometry
    const glassy = part.litSlot !== undefined;
    // And the shell's parts their finish, wear and ground (`shellParts.ts`).
    const looked = part.looks !== undefined;
    const geometry = glassy || looked ? kit.geometry[kind].clone() : kit.geometry[kind];
    let roomBuffer: InstancedInterleavedBuffer | null = null;
    if (glassy) {
      geometry.setAttribute('litSlot', new InstancedBufferAttribute(part.litSlot!, 1));
      // And the room behind each, for the interior drawn through it (`kit.ts`).
      roomBuffer = new InstancedInterleavedBuffer(part.rooms!, ROOM_FLOATS);
      geometry.setAttribute('roomA', new InterleavedBufferAttribute(roomBuffer, 4, 0));
      geometry.setAttribute('roomB', new InterleavedBufferAttribute(roomBuffer, 4, 4));
      geometry.setAttribute('roomC', new InterleavedBufferAttribute(roomBuffer, 4, 8));
    }
    const lookBuffer = looked ? new InstancedInterleavedBuffer(part.looks!, LOOK_FLOATS) : null;
    if (lookBuffer) {
      geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(lookBuffer, 1, 0));
      geometry.setAttribute('aDecay', new InterleavedBufferAttribute(lookBuffer, 1, 1));
      geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(lookBuffer, 1, 2));
    }
    // Faded, each kind as `fade.ts` fades it: the shell's parts with the shell.
    const mesh = new InstancedMesh(geometry, ghost ? kit.ghostParts : partLook(kit, kind, dim).material, count);
    if (glassy || looked) mesh.userData['ownGeometry'] = true;
    mesh.name = `building-${kind}${ghost ? '-preview' : ''}`;
    mesh.castShadow = !ghost && kit.castsShadow.has(kind);
    mesh.receiveShadow = !ghost;
    mesh.instanceMatrix = new InstancedBufferAttribute(part.instanceMatrix, 16);
    if (part.instanceColor) mesh.instanceColor = new InstancedBufferAttribute(part.instanceColor, 3);
    mesh.boundingBox = boxOf(part.bounds);
    mesh.boundingSphere = sphereOf(part.bounds);
    // DO NOT let go of the kit's geometry it draws: it is shared by every batch of the kind.
    if (!ghost) {
      const own: Record<string, BufferAttribute | InstancedInterleavedBuffer> = { instanceMatrix: mesh.instanceMatrix };
      if (mesh.instanceColor) own.instanceColor = mesh.instanceColor;
      // The copy's model: what the kit's has (a shell's part also its white colours).
      const model = looked ? (['position', 'normal', 'uv', 'color'] as const) : (['position', 'normal', 'uv'] as const);
      if (glassy || looked) {
        for (const name of model) own[name] = geometry.getAttribute(name) as BufferAttribute;
        if (geometry.index) own.index = geometry.index;
      }
      if (glassy) {
        own.litSlot = geometry.getAttribute('litSlot') as BufferAttribute;
        own.rooms = roomBuffer!;
      }
      if (lookBuffer) own.looks = lookBuffer;
      const base = kit.geometry[kind];
      gpuOnlyAttributes(mesh, own, () => {
        const again = refill?.().parts[kind];
        if (!again) return {};
        const out: Record<string, ArrayLike<number>> = { instanceMatrix: again.instanceMatrix };
        if (again.instanceColor) out.instanceColor = again.instanceColor;
        if (glassy || looked) {
          for (const name of model) out[name] = (base.getAttribute(name) as BufferAttribute).array.slice();
          if (base.index) out.index = base.index.array.slice();
        }
        if (glassy) {
          out.litSlot = again.litSlot!;
          out.rooms = again.rooms!;
        }
        if (looked) out.looks = again.looks!;
        return out;
      });
    }
    meshes.push(mesh);
    const g = kit.geometry[kind];
    triangles += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * count;
  }
  // Furniture, only where an interior is drawn: one batch per kind.
  // DO NOT read `arrays` in a closure here: V8 would keep it in this function's context, held by every closure of the batch (`setVisible`, the refills), and every cell's CPU arrays would outlive their upload.
  const pieces = arrays.furniture;
  const furnished: FurnitureKind[] = [];
  for (const kind of FURNITURE_KINDS) if (pieces[kind]) furnished.push(kind);
  if (furnished.length) {
    const furniture = kit.furniture();
    for (const kind of furnished) {
      const piece = pieces[kind]!;
      const mesh = new InstancedMesh(furniture.geometry[kind], dim ? kit.dimParts : furniture.material, piece.count);
      mesh.name = `building-furniture-${kind}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix = new InstancedBufferAttribute(piece.instanceMatrix, 16);
      // Faded, white instance colours as every faded part has (`cellArrays.ts`): one program variant of `dimParts`.
      if (dim) mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(piece.count * 3).fill(1), 3);
      mesh.boundingBox = boxOf(piece.bounds);
      mesh.boundingSphere = sphereOf(piece.bounds);
      // On the GPU only, made again from the chunks (`mesh/gpuOnly.ts`).
      gpuOnlyAttributes(mesh, { instanceMatrix: mesh.instanceMatrix }, () => {
        const again = refill?.().furniture[kind];
        return again ? { instanceMatrix: again.instanceMatrix } : {};
      });
      meshes.push(mesh);
      const g = furniture.geometry[kind];
      triangles += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * piece.count;
    }
  }
  // Shell vertices and part instance matrices are already in world space.
  for (const mesh of meshes) {
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  return {
    group,
    triangles,
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      for (const mesh of meshes) {
        // The shell geometry is this build's own; the part geometries are the kit's.
        if (mesh instanceof InstancedMesh) {
          if (mesh.userData['ownGeometry']) mesh.geometry.dispose();
          mesh.dispose();
        } else mesh.geometry.dispose();
      }
      group.clear();
    },
  };
}

const boxOf = (b: Bounds): Box3 => new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
const sphereOf = (b: Bounds): Sphere => new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);

/** Meshes for buildings, emitted afresh (the preview; tests). */
export function buildBuildingMeshes(
  buildings: Iterable<Building>,
  groundAt: GroundAt,
  kit: BuildingKit,
  ghost = false,
  pavedAt?: PavedAt,
  naturalAt: GroundAt = groundAt,
): BuildingMeshes {
  return assembleBuildingMeshes([...buildings].map((b) => emitChunk(b, groundAt, pavedAt, naturalAt)), kit, ghost);
}

/** The furniture of every floor of a building, as it stands inside: what a blow throws out of it when it breaks */
export function interiorFurniture(b: Building, floor: number): Partial<Record<FurnitureKind, PartBatch>> {
  const placed: Partial<Record<FurnitureKind, Placement[]>> = {};
  const e = new Emitter(b, new Shell(), {} as Record<PartKind, Placement[]>, placed);
  let top = 0;
  for (const v of b.volumes) if (!v.open && v.mode !== 'void') top = Math.max(top, volumeTop(v));
  for (let level = 0; level < top; level++) {
    for (const f of interiorAt(b, level).furniture) {
      // Each piece on its own block's floor (a split level, `Volume.lift`).
      const z = floor + liftAt(b, level, f.x, f.y) + levelElevation(b, level);
      placeFurniture(e, f, f.kind === 'ceilingLamp' ? z + levelHeight(b, level) - m(0.06) - f.h : z);
    }
    // Enough to fill the air when it breaks; a tower's every chair cost a second.
    if (Object.values(placed).reduce((n, l) => n + (l?.length ?? 0), 0) > 140) break;
  }
  const out: Partial<Record<FurnitureKind, PartBatch>> = {};
  for (const kind of FURNITURE_KINDS) {
    const list = placed[kind];
    if (!list?.length) continue;
    const matrices = new Float32Array(list.length * 16);
    list.forEach((p, i) => writeMatrix(matrices, i * 16, p));
    out[kind] = { matrices, colours: null, count: list.length };
  }
  return out;
}
