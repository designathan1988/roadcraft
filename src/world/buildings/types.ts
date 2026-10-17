import { internMembers } from './intern';
import { m } from '../units';
import type { Vec2 } from '@core/vec2';
import type { BuildingMaterials, MaterialSpec, VolumeMaterials } from './materials';

/** The modular building model. */

declare const BuildingIdBrand: unique symbol;
export type BuildingId = number & { readonly [BuildingIdBrand]: true };
export const asBuildingId = (n: number): BuildingId => n as BuildingId;

/** The schema written on every stored building. */
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
  // The facade library of the procedural buildings (`architecture.ts`)
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

/** A face of a volume, in the building's local frame: 0 front (local -y, the street side), 1 right (+x), 2 back */
export type Side = 0 | 1 | 2 | 3;
export const SIDES: readonly Side[] = [0, 1, 2, 3];
/** Any edge of an authored footprint. Cardinal `Side` is for oriented parts. */
export type FaceId = number;

export const CORE_KINDS = ['stair', 'lift', 'stairLift'] as const;
export type CoreKind = (typeof CORE_KINDS)[number];

export const SPACE_KINDS = ['unit', 'shop', 'office', 'workshop', 'corridor', 'lobby'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/** A facade: the storey's default component, optional whole-side overrides, and single-bay overrides keyed `"side:index"`. */
export interface Facade {
  fill: BayComponent;
  /** Optional composition for this storey; side compositions take priority. */
  pattern?: FacadePattern;
  patterns?: Partial<Record<FaceId, FacadePattern>>;
  sides?: Partial<Record<FaceId, BayComponent>>;
  bays?: Record<string, BayComponent>;
}

/** Extension point: a subdivision of a storey (a flat, a shop, a corridor). */
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

/** A region of one face pushed in or out */
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

/** The horizontal articulation of a block, as an architectural style draws it */
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
  /** Which way a pitched roof runs. */
  ridge?: 'x' | 'y';
  fall?: Side;
  /** How the block combines with the others, never by changing them: absent, it adds its space (union) */
  mode?: BlockMode;
  /** An open block: a lot, not a building */
  open?: LotSurface;
  /** An open block laid as a TERRACE of a hillside lot: this far above */
  terrace?: number;
  /** An open block laid as a RAMP: the drive of a hillside lot going down or up to a car park or a loading yard at a level of */
  ramp?: number;
  /** A block standing at a floor of its own on a hillside: this far above */
  lift?: number;
}

/** The farthest a terrace of a lot stands above or below its building's floor. */
export const MAX_TERRACE = m(5.5);
/** The farthest a block's own floor stands above or below the building's ground floor. */
export const MAX_LIFT = m(6);

/** What an open block is laid with. */
export const LOT_SURFACES = ['grass', 'paving', 'gravel', 'sand', 'water', 'asphalt', 'concrete', 'pavers', 'tiles'] as const;
export type LotSurface = (typeof LOT_SURFACES)[number];

/** What a building is FOR, in the city: where people live, work, study, buy, eat, are treated, are buried. */
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
  // Lot furniture: a gate in a boundary
  'gate',
  'bin',
  'lamp',
  'bollard',
  'drain',
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** A free part of a building: a flight of stairs, a ramp, a pillar, a canopy, a free-standing wall, a slab. */
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
  /** Rotation of the box about its own centre, radians in the building's local frame. */
  angle?: number;
  material?: MaterialSpec;
}

/** Extension point: a vertical circulation shaft, a module square whose corner is at `(x, y)` in the local frame. */
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
  /** The furniture and lights of each floor as the player arranged them, by level. */
  furnishing?: Record<string, PlacedFurniture[]>;
  /** Drawing only, never stored: the building cut open above this level, to show its inside */
  cutaway?: number;
  /** Drawing only: the way the camera looks (world, horizontal), for which walls of the cut floor come down. */
  cutView?: { readonly x: number; readonly y: number };
  nextVolumeId: number;
  nextElementId?: number;
  name?: string;
  /** The blueprint this building was placed from, for the UI only. */
  blueprint?: string;
}

// ------------------------------------------------------------------ limits Every figure is written in metres

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

/** DO NOT turn this back into a copy (`cloneBuilding`) */
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
  // What it has alike with other buildings shared with them (`intern.ts`): a storey, a facade, a material once for the city.
  internMembers(record);
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

/** DO NOT stamp every generated building at the same minute: the whole city would age at once (a diary entry and a tile write for every building, the same minute). Spread over one tenth of the ageing (`decayOf` steps in tenths), a pure function of the building's id so a building made again from its row (`growth/grownRows.ts`) gets the same. */
export function generatedBuiltAt(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % (DECAY_SPAN / 10);
}

/** How run-down a building built at `builtAt` is at `now`, in tenths. */
export function decayOf(builtAt: number | undefined, now: number): number {
  if (builtAt === undefined || !Number.isFinite(now)) return 0;
  return Math.round(Math.max(0, Math.min(1, (now - builtAt - DECAY_GRACE) / DECAY_SPAN)) * 10) / 10;
}
