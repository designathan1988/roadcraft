import { m } from '../units';
import type { Vec2 } from '@core/vec2';
import type { BuildingMaterials, MaterialSpec, VolumeMaterials } from './materials';

/**
 * The modular building model.
 *
 * A building is DATA: volumes of whole grid cells, storeys on levels, facades
 * of bays, each bay a replaceable component. Nothing here is a mesh, and
 * nothing here knows the editor or the renderer exists.
 */

declare const BuildingIdBrand: unique symbol;
export type BuildingId = number & { readonly [BuildingIdBrand]: true };
export const asBuildingId = (n: number): BuildingId => n as BuildingId;

/**
 * The schema written on every stored building. See `serialize.ts`.
 *
 * 1: volumes, cores and spaces measured in whole cells of `module`.
 * 2: measured in world units, any size (the editor snaps them to `GRID`).
 */
export const BUILDING_SCHEMA = 2;

const BUILDING_USES = ['residential', 'commercial', 'industrial', 'mixed'] as const;
export type BuildingUse = (typeof BUILDING_USES)[number];

/** Replaceable facade components, one per bay. */
export const BAY_COMPONENTS = [
  'wall',
  'window',
  'sashWindow',
  'frenchWindow',
  'bayWindow',
  'ribbon',
  'wideWindow',
  'balcony',
  'door',
  'doubleDoor',
  'garageDoor',
  'shopfront',
  'loadingDoor',
  'pillar',
  // The facade library of the procedural buildings (`architecture.ts`): a
  // loggia let into the wall behind a glass parapet, a window behind
  // vertical sun fins (brise-soleil), a window with louvred shutters folded
  // back beside it, a deep balcony across the whole bay (varanda gourmet).
  'loggia',
  'brise',
  'shutteredWindow',
  'gourmet',
] as const;
export type BayComponent = (typeof BAY_COMPONENTS)[number];

export const FACADE_PATTERNS = ['residential', 'storefront', 'office', 'industrial', 'arcade', 'gallery', 'artDeco', 'artDecoCrown', 'observation'] as const;
export type FacadePattern = (typeof FACADE_PATTERNS)[number];
export const isFacadePattern = (value: unknown): value is FacadePattern =>
  (FACADE_PATTERNS as readonly unknown[]).includes(value);

export const ROOF_KINDS = ['flat', 'terrace', 'gable', 'hip', 'shed', 'sawtooth'] as const;
export type RoofKind = (typeof ROOF_KINDS)[number];

import type { FlagDesign } from './flags';

const ROOF_DETAIL_KINDS = ['solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire', 'lantern'] as const;
export type RoofDetailKind = (typeof ROOF_DETAIL_KINDS)[number];
export const isRoofDetailKind = (value: unknown): value is RoofDetailKind =>
  (ROOF_DETAIL_KINDS as readonly unknown[]).includes(value);
export interface RoofDetail {
  id: number;
  kind: RoofDetailKind;
  /** Position in the building's local plan, on the owning volume's roof. */
  x: number;
  y: number;
  rotation: number;
  w: number;
  d: number;
  /** Height above the roof, in world units; used by adjustable details. */
  h?: number;
  /** Optional flag on a spire or a lantern's mast; plain leaves a coloured banner for generic buildings. */
  flag?: 'none' | 'plain' | 'saoPaulo' | 'saoPauloState';
  /** The flag's own design (pattern and colours); absent, `flag` names a fixed one. */
  flagDesign?: FlagDesign;
}

/**
 * A face of a volume, in the building's local frame: 0 front (local -y, the
 * street side), 1 right (+x), 2 back (+y), 3 left (-x).
 */
export type Side = 0 | 1 | 2 | 3;
export const SIDES: readonly Side[] = [0, 1, 2, 3];
/** Any edge of an authored footprint. Cardinal `Side` is for oriented parts. */
export type FaceId = number;

export const CORE_KINDS = ['stair', 'lift', 'stairLift'] as const;
export type CoreKind = (typeof CORE_KINDS)[number];

export const SPACE_KINDS = ['unit', 'shop', 'office', 'workshop', 'corridor', 'lobby'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/**
 * A facade: the storey's default component, optional whole-side overrides,
 * and single-bay overrides keyed `"side:index"`. Resolved by `componentAt`.
 */
export interface Facade {
  fill: BayComponent;
  /** Optional composition for this storey; side compositions take priority. */
  pattern?: FacadePattern;
  patterns?: Partial<Record<FaceId, FacadePattern>>;
  sides?: Partial<Record<FaceId, BayComponent>>;
  bays?: Record<string, BayComponent>;
}

/**
 * Extension point: a subdivision of a storey (a flat, a shop, a corridor).
 * Stored and round-tripped; nothing simulates it yet. A rectangle of the
 * building's local frame, world units.
 */
export interface Space {
  id: number;
  x: number;
  y: number;
  w: number;
  d: number;
  kind: SpaceKind;
  use?: BuildingUse;
}

export interface Storey {
  /** Overrides the building's use on this storey (mixed use). */
  use?: BuildingUse;
  facade: Facade;
  /** Face finishes for this floor, over mass and building finishes. */
  materials?: Partial<Record<FaceId, MaterialSpec>>;
  /** Extension point, see `Space`. */
  spaces?: Space[];
}

/**
 * A region of one face pushed in or out: whole bays `bay0..bay1` of `side`,
 * on storeys `storey0..storey1` of the volume, moved `depth` world units
 * along the face's outward normal - negative is a RECESS (a loggia, an inset
 * panel, a porch), positive a PROJECTION (a bay window, a raised panel, a
 * pilaster). Stored in bays and storeys, so it follows the facade when the
 * volume is resized.
 */
export interface Relief {
  side: FaceId;
  bay0: number;
  bay1: number;
  storey0: number;
  storey1: number;
  depth: number;
}

/** Measured facade rhythm on one physical face of a volume. */
export interface FacadeGeometry {
  /** Number of equally spaced structural bays along this face. */
  bays?: number;
  /** Fractions of each bay's width and storey's height used by openings. */
  windowWidth?: number;
  windowHeight?: number;
  /** Absolute height of the window sill above its floor, in world units. */
  sill?: number;
  /** Projecting vertical pier dimensions, in world units; depth 0 removes it. */
  pierWidth?: number;
  pierDepth?: number;
  pierEvery?: number;
}

/**
 * The horizontal articulation of a block, as an architectural style draws
 * it (base, body and crown - Sullivan's base, shaft and cornice; the
 * embasamento, corpo and coroamento of a Brazilian facade):
 * - lines: 'every' a moulding at every floor; 'base' one string course over
 *   the ground floor only; 'slab' the floor slabs shown as thin flush
 *   bands; 'none' an unbroken body;
 * - crown: 'cornice' a moulded cornice; 'deco' a stepped double cornice;
 *   'slab' a thin projecting roof slab; 'attic' a deep plain parapet band;
 *   'none' the wall runs to the coping.
 */
export const DRESS_LINES = ['every', 'base', 'slab', 'none'] as const;
export const DRESS_CROWNS = ['cornice', 'deco', 'slab', 'attic', 'none'] as const;
export interface VolumeDress {
  lines?: (typeof DRESS_LINES)[number];
  crown?: (typeof DRESS_CROWNS)[number];
}

/** A rectangular block, standing on level `base`: a rectangle of the local frame, world units. */
export interface Volume {
  id: number;
  x: number;
  y: number;
  w: number;
  d: number;
  /** Optional simple counterclockwise polygon, normalized to x/y/w/d. */
  outline?: Vec2[];
  /** The generative composition last applied to this mass. */
  facadePattern?: FacadePattern;
  /** Independent bay and pier proportions on any face. */
  facadeGeometry?: Partial<Record<FaceId, FacadeGeometry>>;
  roofDetails?: RoofDetail[];
  base: number;
  roof: RoofKind;
  /** Bottom to top: storey k occupies level `base + k`. */
  storeys: Storey[];
  /** This volume's own walls and roof, over the building's (see `materials.ts`). */
  materials?: VolumeMaterials;
  /** Faces pushed in or out (see `Relief`). */
  reliefs?: Relief[];
  /** How its storeys are marked and its top finished (see `VolumeDress`); absent, a line at every floor and a plain cornice. */
  dress?: VolumeDress;
  /** Roof pitch in degrees, for pitched roofs; absent = the roof kind's default. */
  pitch?: number;
  /**
   * Which way a pitched roof runs. Gable and hip: the ridge along the local x
   * axis ('x') or y ('y'); absent = along the longer side. Shed: the side it
   * falls towards (absent = the front).
   */
  ridge?: 'x' | 'y';
  fall?: Side;
  /**
   * How the block combines with the others, never by changing them: absent,
   * it adds its space (union); 'void' takes its space out of the solid blocks
   * it overlaps (a cut that stays a block: moved, resized or deleted, the cut
   * follows); 'intersect' keeps of the solid blocks only what lies inside it;
   * 'xor' adds where it meets no solid block and removes where it does.
   * Resolved when drawn (`blocks.ts`), stored as the blocks themselves.
   */
  mode?: BlockMode;
  /**
   * An open block: a lot, not a building - no walls, no roof, its plan laid
   * on the ground as grass, paving, gravel, sand or water (a park, a square,
   * a schoolyard, a cemetery, a court). Edited like any block.
   */
  open?: LotSurface;
  /**
   * An open block laid as a TERRACE of a hillside lot: this far above (or,
   * negative, below) the building's ground floor, world units, level, held
   * by a retaining wall where it meets the next platform (a yard stepped up
   * or down the slope behind a house, `editor/lotPlan.ts`). Absent: the
   * lot's own rule (`lots.ts`: level with the floor, or falling with the
   * street it opens onto). At most `MAX_TERRACE` either way.
   */
  terrace?: number;
  /**
   * An open block laid as a RAMP: the drive of a hillside lot going down or
   * up to a car park or a loading yard at a level of its own. Its surface
   * runs straight along its depth (the local y), from this far above (below)
   * the building's ground floor at its front edge to its `terrace` (absent:
   * the floor) at its back edge - a car drives it as it drives a street's
   * grade. At most `MAX_TERRACE` either way.
   */
  ramp?: number;
  /**
   * A block standing at a floor of its own on a hillside: this far above (or,
   * negative, below) the building's ground floor, world units, the whole
   * block - its storeys, its roof, its plinth - moved with it. A split-level
   * or a back-split house steps half a storey; a block with a lower ground
   * floor exposed on the downhill side steps a whole one (`splitLevel.ts`).
   * The levels stay the building's: storey k of the block is still level
   * `base + k`, at `lift + levelElevation(base + k)`. Absent: 0. A block
   * standing on another carries the lift of the block under it.
   */
  lift?: number;
}

/** The farthest a terrace of a lot stands above or below its building's floor. */
export const MAX_TERRACE = m(5.5);
/** The farthest a block's own floor stands above or below the building's ground floor. */
export const MAX_LIFT = m(6);

/**
 * What an open block is laid with. Each area of a lot has its own: a lawn, a
 * stone forecourt, a concrete drive or service yard, an asphalt car park and
 * its aisle, interlocking pavers on a path or a patio, terracotta tiles on a
 * terrace, gravel, sand, a pool.
 */
export const LOT_SURFACES = ['grass', 'paving', 'gravel', 'sand', 'water', 'asphalt', 'concrete', 'pavers', 'tiles'] as const;
export type LotSurface = (typeof LOT_SURFACES)[number];

/**
 * What a building is FOR, in the city: where people live, work, study, buy,
 * eat, are treated, are buried. It picks the building's first form (a model
 * of blocks, then edited freely), its inside, and its part in the residents'
 * days.
 */
export const BUILDING_FUNCTIONS = [
  // homes
  'house', 'townhouse', 'apartments', 'residentialTower',
  // public services
  'cityHall', 'council', 'courthouse', 'postOffice', 'police', 'fireStation', 'hospital', 'clinic',
  'school', 'university', 'library', 'museum', 'prison', 'church', 'cemetery', 'busStation',
  // private: shops, food, services, nights out
  'shop', 'supermarket', 'mall', 'bank', 'pharmacy', 'bakery', 'restaurant', 'snackBar', 'bar',
  'nightclub', 'cinema', 'hotel', 'gym', 'club', 'gasStation', 'office',
  // work
  'factory', 'warehouse',
  // leisure
  'park', 'square', 'playground', 'sportsCourt',
] as const;
export type BuildingFunction = (typeof BUILDING_FUNCTIONS)[number];

/** One piece of furniture or a light placed by the player, in the building's local frame. */
export interface PlacedFurniture {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  /** The way it faces, radians (0 faces -y). */
  readonly angle: number;
}

export type BlockMode = 'void' | 'intersect' | 'xor';

/** Free parts a building can be given besides its volumes. */
export const ELEMENT_KINDS = [
  'stair',
  'ramp',
  'pillar',
  'canopy',
  'wall',
  'slab',
  'pavement',
  'fence',
  'tree',
  'bench',
  'ac',
  'planter',
  'railing',
  'awning',
  'flowers',
  'rocks',
  'parking',
  'clock',
  'hedge',
  'shrub',
  // Lot furniture: a gate in a boundary (a car's or a person's, by its width),
  // wheelie bins, a lamp post, a bollard, a drain grate.
  'gate',
  'bin',
  'lamp',
  'bollard',
  'drain',
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/**
 * A free part of a building: a flight of stairs, a ramp, a pillar, a canopy,
 * a free-standing wall, a slab. A box of the building's local frame - its
 * plan centred on `(x, y)`, `w` across and `d` along the direction it faces
 * (`facing`, a side of the local frame), from `z` above the ground floor up
 * `h`. For a stair or a ramp `facing` is the way it goes DOWN and `h` its
 * rise; for a canopy `facing` is the way it projects and `h` its thickness.
 * It moves, turns and is demolished with its building.
 */
export interface BuildingElement {
  id: number;
  kind: ElementKind;
  x: number;
  y: number;
  facing: Side;
  w: number;
  d: number;
  z: number;
  h: number;
  /**
   * Rotation of the box about its own centre, radians in the building's local
   * frame. Absent (0) means the box is aligned with `facing`, which is what
   * every hand-placed part is; a run drawn along a path sets it so a fence or
   * a wall follows the line it was traced on.
   */
  angle?: number;
  material?: MaterialSpec;
}

/**
 * Extension point: a vertical circulation shaft, a module square whose
 * corner is at `(x, y)` in the local frame. A lift core is drawn as an
 * overrun box on a flat roof; nothing moves in it yet.
 */
export interface Core {
  id: number;
  x: number;
  y: number;
  kind: CoreKind;
  from: number;
  to: number;
}

export interface Building {
  readonly id: BuildingId;
  schema: number;
  /** World position of the local frame's origin (cell 0,0's corner). */
  x: number;
  y: number;
  /** Radians, counter-clockwise, of the local +x axis. */
  rotation: number;
  use: BuildingUse;
  /** The width a facade bay aims at, world units: each side is shared into bays of about this. */
  module: number;
  /** Height of level 0, world units. */
  groundHeight: number;
  /** Height of every level above 0, world units. */
  storeyHeight: number;
  /** Per-level height overrides, building-wide; `null`/absent = default. */
  levels?: (number | null)[];
  /** Colour scheme: the default material of every surface (`PALETTE_MATERIALS`). */
  palette: number;
  /** Building-wide materials, over the palette (see `materials.ts`). */
  materials?: BuildingMaterials;
  volumes: Volume[];
  /** Free parts: stairs, ramps, pillars, canopies, walls, slabs. */
  elements?: BuildingElement[];
  cores: Core[];
  /** What the building is for (absent: a plain building of its `use`). */
  function?: BuildingFunction;
  /** When it was built or last renovated, city minutes; absent: it does not age. */
  builtAt?: number;
  /** The version of the lot generator a zoned building was grown with (`LOT_PLAN_VERSION`). */
  lotPlan?: number;
  /** How run-down it is, 0 (new) to 1 (falling apart), from its age (`decayOf`). */
  decay?: number;
  /**
   * The furniture and lights of each floor as the player arranged them, by
   * level. A floor with none here is furnished for the building's function
   * (`interior.ts`); the first edit stores that arrangement and changes it.
   */
  furnishing?: Record<string, PlacedFurniture[]>;
  /**
   * Drawing only, never stored: the building cut open above this level, to
   * show its inside (the Construction tool's interior view).
   */
  cutaway?: number;
  /** Drawing only: the way the camera looks (world, horizontal), for which walls of the cut floor come down. */
  cutView?: { readonly x: number; readonly y: number };
  nextVolumeId: number;
  nextElementId?: number;
  name?: string;
  /** The blueprint this building was placed from, for the UI only. */
  blueprint?: string;
}

// ------------------------------------------------------------------ limits
// Every figure is written in metres (`m()`, `world/units.ts`).

export const MIN_MODULE = m(2.4);
export const MAX_MODULE = m(8);
export const DEFAULT_MODULE = m(3);
export const MIN_STOREY_HEIGHT = m(2.6);
export const MAX_STOREY_HEIGHT = m(9);
export const MAX_GROUND_HEIGHT = m(20);
export const MAX_STOREYS = 60;
/** Widest a volume may be on either axis, world units. */
export const MAX_SIZE = m(160);
export const MAX_VOLUMES = 24;
/** Deepest a recess may go into a volume, and furthest a projection may stand out. */
export const MAX_RECESS = m(4);
export const MAX_PROJECTION = m(2.4);
export const MIN_PITCH = 5;
export const MAX_PITCH = 60;
export const PALETTE_COUNT = 8;

export const isBuildingUse = (v: unknown): v is BuildingUse =>
  (BUILDING_USES as readonly unknown[]).includes(v);
export const isBayComponent = (v: unknown): v is BayComponent =>
  (BAY_COMPONENTS as readonly unknown[]).includes(v);
export const isRoofKind = (v: unknown): v is RoofKind =>
  (ROOF_KINDS as readonly unknown[]).includes(v);
export const isSide = (v: unknown): v is Side => v === 0 || v === 1 || v === 2 || v === 3;
export const isElementKind = (v: unknown): v is ElementKind => (ELEMENT_KINDS as readonly unknown[]).includes(v);
/** A whole property - walls, gates, paths, car park, garden, cornices - fits. */
export const MAX_ELEMENTS = 128;

export const bayKey = (side: FaceId, index: number): string => `${side}:${index}`;

/** The component a facade puts in one bay. */
export function componentAt(facade: Facade, side: FaceId, index: number): BayComponent {
  return facade.bays?.[bayKey(side, index)] ?? facade.sides?.[side] ?? facade.fill;
}

/** A deep, independent copy. Buildings are small; JSON is the honest clone. */
export function cloneBuilding<T extends Building>(b: T): T {
  return JSON.parse(JSON.stringify(b)) as T;
}

/**
 * Makes a record the plain JSON data `cloneBuilding` would have made of it,
 * IN PLACE, without copying it: -0 becomes 0, NaN and the infinities null,
 * an `undefined` (or function) member is taken out and an `undefined` item
 * of a list becomes null - exactly what `JSON.parse(JSON.stringify(b))`
 * reads back, the same members in the same order. The store keeps the
 * records it is handed (`store.ts`, OWNERSHIP) and they stay what they were
 * when it copied them.
 *
 * `settled`: the records made plain before (the store's, shared with its
 * clones: `BuildingStore.shareFrom`); one of them handed back (an undo, a
 * clone's records) is returned at once, and this one joins them. `was`: the
 * record this one replaces; a member that is the very object the old record
 * had (`put({ ...stored, decay })`), when that record was settled itself,
 * is plain already and is not walked again. Both lean on stored records
 * never being changed in place (`store.ts`, OWNERSHIP).
 *
 * DO NOT turn this back into a copy (`cloneBuilding`): writing every record
 * out as text and parsing it again was the largest cost of growing a
 * generated city (2.2 s of a 2.5 km one), for records nobody else held.
 */
export function settleBuilding<T extends object>(b: T, settled: WeakSet<object>, was?: object): T {
  if (settled.has(b)) return b;
  const record = b as Record<string, unknown>;
  // Only a record settled itself vouches for its members (one loaded from a file was never walked).
  const old = was !== undefined && settled.has(was) ? was as Record<string, unknown> : undefined;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (old !== undefined && typeof value === 'object' && value !== null && old[key] === value) continue;
    settleMember(record, key, value);
  }
  settled.add(b);
  return b;
}

function settleMember(owner: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) owner[key] = 0;
    else if (!Number.isFinite(value)) owner[key] = null;
  } else if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    delete owner[key];
  } else if (typeof value === 'object' && value !== null) {
    settleValue(value);
  }
}

function settleValue(value: object): void {
  if (Array.isArray(value)) {
    const list = value as unknown[];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (typeof item === 'number') {
        if (Object.is(item, -0)) list[i] = 0;
        else if (!Number.isFinite(item)) list[i] = null;
      } else if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        list[i] = null;
      } else if (typeof item === 'object' && item !== null) {
        settleValue(item);
      }
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) settleMember(record, key, record[key]);
}

/** The level a volume's roof sits on (one past its top storey). */
export const volumeTop = (v: Volume): number => v.base + v.storeys.length;

export function volumeById(b: Building, id: number): Volume | undefined {
  return b.volumes.find((v) => v.id === id);
}

/** City minutes a building stays as new before it starts to age: five days. */
export const DECAY_GRACE = 5 * 1440;
/** City minutes from the first stains to falling apart, without maintenance: thirty days. */
export const DECAY_SPAN = 30 * 1440;

/** How run-down a building built at `builtAt` is at `now`, in tenths. */
export function decayOf(builtAt: number | undefined, now: number): number {
  if (builtAt === undefined || !Number.isFinite(now)) return 0;
  return Math.round(Math.max(0, Math.min(1, (now - builtAt - DECAY_GRACE) / DECAY_SPAN)) * 10) / 10;
}
