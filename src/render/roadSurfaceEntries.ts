import type { ChangeRect } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import { Level, type SurfaceLevel } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import { m } from '@world/units';
import type { Input } from './roadSurfaceRings';

/** THE ROAD SURFACES' INPUTS AS THEY ARE FILED (`roadSurfaceInputs.ts`): the tiles, the entries, their kinds and the order a walk of the map
 *  meets them in, and what the inputs held round the view count an item by (`InputResidency`) - plain data and pure functions. */

/** World size of one tile. */
export const TILE = m(76.8);
/** Where the tile grid starts. */
export const TILE_ORIGIN = m(0.1484);
/** How far round a tile a ring may reach and still be read by it. */
export const TILE_REACH = m(0.2);
export const TILE_BIAS = 1 << 15;

/** A tile's key from its column and row. */
export const tileKey = (ix: number, iy: number): number => (ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS);

/** How many items had their inputs made, for the scale tests: an edit far away makes few. */
export const surfaceInputWork = { segments: 0, nodes: 0 };

/** Everything that reaches a tile of a pass, by kind, in input order. */
export interface Reach {
  readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Input[]>;
  readonly medians: Record<'kerb' | 'planting' | 'paved', readonly Input[]>;
  readonly ramps: readonly Input[];
  readonly ribbons: readonly Input[];
  readonly quads: ReadonlyMap<string, readonly Input[]>;
}

/** One input of an item, as a pass files it: its kind (`slot`), its pass, and where a walk of the map meets it - `phase` */
export interface Entry {
  readonly input: Input;
  readonly slot: string;
  readonly phase: number;
  readonly id: number;
  readonly seq: number;
  /** The pass it belongs to; `DETAILS`: every pass at ground level reads it where it paints (`reachOf`). */
  readonly pass: string;
  readonly tiles: readonly number[];
}

/** The junctions' stop lines, zebras, islands and legends */
export const DETAILS = '*details';

export const LEVEL_SLOTS = ['casing', 'sidewalk', 'curb', 'asphalt'] as const;
export const LEVEL_OF: Readonly<Record<(typeof LEVEL_SLOTS)[number], SurfaceLevel>> = {
  casing: Level.Casing as SurfaceLevel,
  sidewalk: Level.Sidewalk as SurfaceLevel,
  curb: Level.Curb as SurfaceLevel,
  asphalt: Level.Asphalt as SurfaceLevel,
};
export const MEDIAN_SLOTS = ['kerb', 'planting', 'paved'] as const;
export const medianSlot = (part: string): string => `median:${part}`;
export const paintSlot = (color: string): string => `paint:${color}`;
export const PAINT_PREFIX = 'paint:';

/** The phases of the walk the inputs are ordered by, as `roadSurfaces.ts` once walked the map */
export const PHASE = {
  road: 0, junction: 1,
  taper: 1, mini: 2,
  lines: 0, parking: 1, taperPaint: 2, stops: 3, midStops: 4, zebras: 5, midZebras: 6, islands: 7, legends: 8,
} as const;

export const byWalk = (p: Entry, q: Entry): number => p.phase - q.phase || p.id - q.id || p.seq - q.seq;

/** A tile of one pass: its entries by slot, and what it reads once put together. */
export interface TileInputs {
  readonly key: number;
  readonly slots: Map<string, Set<Entry>>;
  /** The pass's own entries in it; at none it goes. */
  own: number;
  /** Of them, the carriageway the paint is clipped to: only then does it read the junctions' paint. */
  ribbons: number;
  /** Put together (`reachOf`) and its digest; null when something in it changed since. */
  reach: Reach | null;
  digest: number;
  /** The paint colours it holds, in order. */
  colours: readonly string[];
}

/** One pass's tiles, by key. */
export interface PassInputs {
  readonly id: string;
  /** Whether it reads the junctions' paint (`DETAILS`): a pass at ground level. */
  readonly ground: boolean;
  readonly tiles: Map<number, TileInputs>;
  /** The tiles the items not derived now may put inputs in (`Superset`), with how many may: the pass has them, made when visited (`wakeTile`). */
  readonly dormant: Map<number, number>;
  /** When it was made (`births`): a pass let go and made again is another pass to the build. */
  readonly born: number;
  /** The tiles whose inputs changed (or that went) since the build last took them (`settle`). */
  readonly dirty: Set<number>;
}

/** A pass of the surfaces as the build walks it: a structural level, or an alignment raised by hand. */
export interface SurfacePass {
  readonly id: string;
  readonly structure: RoadStructure;
  readonly segment?: SegmentId;
  readonly chain?: readonly SegmentId[];
}

/** Where an item not derived now may put inputs: the tiles its box reaches in each pass it may draw in. */
export interface Superset {
  readonly passes: readonly string[];
  readonly tiles: readonly number[];
}

export interface SegmentItem {
  readonly pass: string | null;
  readonly ends: readonly [NodeId, NodeId];
  /** Its inputs, filed; null: not derived now (held round the view, `InputResidency`), its `superset` filed instead. */
  readonly entries: readonly Entry[] | null;
  /** The box its inputs lie in, world units; null: it has none. */
  readonly box: ChangeRect | null;
  readonly superset: Superset | null;
  /** What its inputs hold, bytes (`entryBytes`). */
  readonly bytes: number;
}

export interface NodeItem {
  readonly entries: readonly Entry[] | null;
  readonly box: ChangeRect | null;
  readonly superset: Superset | null;
  readonly bytes: number;
}

/** How the inputs are held round the view (`viewCells.ts`): what the cells derived round the tiles visited may hold on the CPU, and how far round the eye they are kept. */
export interface InputResidency {
  readonly cpuBudget: number;
  readonly reach: number;
}

/** The game's residency (`renderer.ts`): the cells round the roads' focus kept, where the player edits (a tile farther is derived when a build
 *  visits it, `wakeTile`), and room for a build's visit to sweep the map a column of cells at a time without deriving one again. */
export const ROAD_INPUT_RESIDENCY: InputResidency = Object.freeze({ cpuBudget: 48 * 1048576, reach: m(400) });

/** The items a cell of the residency found when it was derived: let go with it unless another held cell meets them. */
export interface CellHold {
  readonly segments: readonly SegmentId[];
  readonly nodes: readonly NodeId[];
}

/** How far past a tile its visit derives the items round it (`wakeTile`): a junction's plate and a corner's dropped kerb past its roads' boxes, the footway's outline read round a tile (`footwayEdges`). */
export const WAKE_PAD = m(24);
/** How far past its roads' boxes and its plates a node's inputs may lie (its dropped kerbs, its paint). */
export const NODE_PAD = m(6);
/** What an entry's input holds besides its points, and each point (a two-number array in a ring), bytes: an estimate for the budget, set against the heap the whole large city's inputs took in Node (88 MB, 2026-10-21). */
export const ENTRY_BYTES = 460;
export const POINT_BYTES = 124;
/** Each tile an entry is filed in: its place in the tile's set. */
export const TILE_BYTES = 24;

/** What an item's entries hold on the CPU, bytes (an estimate, `ENTRY_BYTES`). */
export function entryBytes(entries: readonly Entry[]): number {
  let n = 0;
  for (const e of entries) {
    n += ENTRY_BYTES + e.tiles.length * TILE_BYTES;
    for (const ring of e.input.poly) n += ring.length * POINT_BYTES;
  }
  return n;
}

/** The tiles a box reaches, by the rule an entry is filed by (`entryOf`). */
export function tilesOver(box: ChangeRect): number[] {
  const tiles: number[] = [];
  const x0 = Math.floor((box[0] - TILE_REACH - TILE_ORIGIN) / TILE), x1 = Math.floor((box[2] + TILE_REACH - TILE_ORIGIN) / TILE);
  const y0 = Math.floor((box[1] - TILE_REACH - TILE_ORIGIN) / TILE), y1 = Math.floor((box[3] + TILE_REACH - TILE_ORIGIN) / TILE);
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) tiles.push(tileKey(ix, iy));
  return tiles;
}

/** A tile's rectangle from its key. */
export function tileRectOf(key: number): ChangeRect {
  const ix = Math.floor(key / 0x1_0000) - TILE_BIAS, iy = (key % 0x1_0000) - TILE_BIAS;
  return [ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN];
}

export const growRect = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
export const unite = (a: ChangeRect | null, b: ChangeRect | null): ChangeRect | null =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

export const alignmentPass = (root: SegmentId): string => `alignment-${root}`;
/** A pass at ground level: the ground's, or an alignment raised by hand (drawn from the ground's structure). */
export const isGroundPass = (pass: string): boolean => pass === 'ground' || pass.startsWith('alignment-');

export function entryOf(input: Input, slot: string, phase: number, id: number, seq: number, pass: string): Entry {
  const tiles: number[] = [];
  const x0 = Math.floor((input.minX - TILE_REACH - TILE_ORIGIN) / TILE);
  const x1 = Math.floor((input.maxX + TILE_REACH - TILE_ORIGIN) / TILE);
  const y0 = Math.floor((input.minY - TILE_REACH - TILE_ORIGIN) / TILE);
  const y1 = Math.floor((input.maxY + TILE_REACH - TILE_ORIGIN) / TILE);
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) tiles.push(tileKey(ix, iy));
  return { input, slot, phase, id, seq, pass, tiles };
}
