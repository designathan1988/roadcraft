import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { TILE } from '../tiles';
import { m } from '../units';
import type { ZoneDensity, ZoneUse } from '../zones';
import { valueNoise } from './field';
import type { CityOptions, CityStyle } from './plan';

/** THE MAP (the player's order, 2026-10-16): a square of `MAP_TILES` tiles each way round the origin, 10 km x 10 km, the city over the WHOLE of it; never a world without an edge. The size will be the player's choice; the rules below stay pure functions of the seed and the place, so a larger map is the same rules over more tiles. */
export const MAP_TILES = 10;
/** The map's half side, world units. */
export const MAP_HALF = (MAP_TILES / 2) * TILE;
/** Whether tile (i, j) is on the map (-5..4 each way at 10). */
export const tileOnMap = (i: number, j: number): boolean => i >= -MAP_TILES / 2 && i < MAP_TILES / 2 && j >= -MAP_TILES / 2 && j < MAP_TILES / 2;
/** Whether a point is on the map. */
export const onMap = (x: number, y: number): boolean => x >= -MAP_HALF && x < MAP_HALF && y >= -MAP_HALF && y < MAP_HALF;
/** A point held to the map (the camera's focus). */
export const clampToMap = (x: number, y: number): { x: number; y: number } => ({ x: Math.max(-MAP_HALF, Math.min(MAP_HALF, x)), y: Math.max(-MAP_HALF, Math.min(MAP_HALF, y)) });

/** THE WORLD AS CITIES AND COUNTRYSIDE (rewrite F7, "Streaming world"): the world's tiles (`tiles.ts`), each planned and built on its own (`tile.ts`, `editor/wholeMapTile.ts`) from the seed and its own place alone, so any tile of an unbounded world can be made in any order on any worker and come out the same. What the tiles share is decided here, by rules that read only the seed and the coordinates: the border avenues on every tile edge, the gates where streets cross them (the same for a whole row or column of tiles, so a street goes straight on into the next tile), and the districts - downtowns, neighbourhood centres, villages, industry, parks - from an endless lattice of district cells, each holding a city or countryside by a hash of the seed and the cell. */

/** No gate this near a tile's corner: the corner is the two border avenues' junction. */
const CORNER = m(110);
/** Distance between two gates of a border, at least and at most. */
const GATE_MIN = m(140);
const GATE_MAX = m(260);
/** Share of the gates that are avenues: a straight avenue across the world every few kilometres. */
const AVENUE_GATES = 0.2;

/** The whole map's options: a generated city's (`CityOptions`) without a size; style 'mixed' picks a style per tile. */
export type WholeMapOptions = Omit<CityOptions, 'size' | 'radius'>;

/** What the whole map asks when the player asks only for it: a style per tile, three centres, some parks. */
export const WHOLE_MAP_DEFAULTS: Pick<WholeMapOptions, 'style' | 'centres' | 'parks'> = { style: 'mixed', centres: 3, parks: 0.05 };

/** The line of border `k` along either axis, for any integer `k`: the tiles' edges (`tiles.ts`), exact multiples of `TILE`. */
export const borderLine = (k: number): number => k * TILE;

/** A street's crossing of a border avenue; `level` 0 an avenue, 1 a collector (`LEVEL_ROAD`). */
export interface Gate {
  readonly at: number;
  readonly level: 0 | 1;
}

/** A hash of a few integers: the seed of a rule's own stream. */
export function mix(...values: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** The gates of row or column `k`, any integer (`axis` 0: across the borders x = const of row k, at these y; 1: across y = const of column k, at these x). */
export function gatesOf(seed: number, axis: 0 | 1, k: number): Gate[] {
  // No street crosses the map's edge nor runs past it: no gate on its border lines or beyond.
  if (k <= -MAP_TILES / 2 || k >= MAP_TILES / 2) return [];
  const lo = borderLine(k) + CORNER, hi = borderLine(k + 1) - CORNER;
  const rng = new Rng(mix(seed, 0x6a7e, axis, k));
  const out: Gate[] = [];
  for (let at = lo + rng.range(0, GATE_MAX - GATE_MIN); at <= hi; at += rng.range(GATE_MIN, GATE_MAX)) {
    out.push({ at, level: rng.float() < AVENUE_GATES ? 0 : 1 });
  }
  return out;
}

/** A centre: how strongly it draws and how far; a downtown or a neighbourhood's. */
interface Hub { readonly x: number; readonly y: number; readonly radius: number; readonly weight: number; readonly downtown: boolean }

/** What a tile is: how built up, and how its streets are laid. */
export type TileKind = 'downtown' | 'urban' | 'suburb' | 'industrial' | 'rural';
/** A tile's street style: a generated city's (`CityStyle`), or the countryside's (its border avenues and avenue gates only). */
export type TileStyle = Exclude<CityStyle, 'mixed'> | 'rural';

export interface TileCharacter {
  readonly kind: TileKind;
  readonly style: TileStyle;
  /** The heat at the tile's middle (`heatAt`). */
  readonly heat: number;
  /** The centre a radial tile turns round. */
  readonly hub: Vec2;
}

/** Heat at or over which a place is downtown, urban, a suburb; under the last, countryside. */
const DOWNTOWN = 0.72;
const URBAN = 0.45;
const SUBURB = 0.24;
/** The least heat on the map: built up everywhere (suburbs at the least), the downtowns and the centres over it (the city over the whole map). */
const MAP_FLOOR = SUBURB + 0.03;
/** Centres of neighbourhoods besides a city's downtowns. */
const SUB_CENTRES = 6;
/** Industrial districts of a city, and their reach. */
const WORKS = 2;
const WORKS_REACH = m(700);

/** A district cell's side: 8 tiles, so its edges are tiles' edges; cell (0, 0) is centred on the origin. */
const DISTRICT = TILE * 8;
/** Cells each way whose centres can reach a place: a city's centres stand within ~7.3 km of its cell's middle and pull a radius of 3 km at most, so a cell 3 away adds under 1e-7 - left out. */
const NEAR = 2;
/** A city's first downtown, this far from its cell's middle at most (the cell at the origin: the player's start, near the middle). */
const CITY_JITTER = m(1600);
const ORIGIN_JITTER = m(600);
/** Share of district cells holding a city at density 0 and 1 (the cell at the origin always does). */
const CITY_SHARE: readonly [number, number] = [0.22, 0.55];
/** Share of the other cells holding a village: one neighbourhood centre in the countryside. */
const VILLAGE_SHARE = 0.6;

export interface WholeMapPlan {
  readonly options: WholeMapOptions;
  /** The downtowns of the district cells round a place. */
  centresNear(p: Vec2): readonly Vec2[];
  /** How built up a place is: about 1 at a downtown, 0 in the countryside. */
  heatAt(x: number, y: number): number;
  tile(i: number, j: number): TileCharacter;
  /** What the land at a point is for (`CityPlan.zoneAt`). */
  zoneAt(p: Vec2, onMain: boolean): { use: ZoneUse; density: ZoneDensity } | 'park';
}

/** The tile's middle. */
const tileMiddle = (i: number, j: number): Vec2 => ({ x: (borderLine(i) + borderLine(i + 1)) / 2, y: (borderLine(j) + borderLine(j + 1)) / 2 });

/** What one district cell holds: its centres and its industry. */
interface District { readonly hubs: readonly Hub[]; readonly works: readonly Vec2[] }

/** District cell (`cx`, `cy`): a city (downtowns, neighbourhood centres round them, industry away from them), a village, or open country - a pure function of the seed and the cell. */
function districtOf(options: WholeMapOptions, cx: number, cy: number): District {
  const rng = new Rng(mix(options.seed, 0xc17e, cx, cy));
  const origin = cx === 0 && cy === 0;
  const density = Math.max(0, Math.min(1, options.density));
  // Both draws taken whatever comes of them: the stream stays the same for every rule after.
  const cityDraw = rng.float(), villageDraw = rng.float();
  const mid = { x: cx * DISTRICT, y: cy * DISTRICT };
  if (!origin && cityDraw >= CITY_SHARE[0] + (CITY_SHARE[1] - CITY_SHARE[0]) * density) {
    if (villageDraw >= VILLAGE_SHARE) return { hubs: [], works: [] };
    const reach = DISTRICT * 0.35;
    return { hubs: [{ x: mid.x + rng.range(-1, 1) * reach, y: mid.y + rng.range(-1, 1) * reach, radius: rng.range(m(900), m(1300)), weight: rng.range(0.5, 0.62), downtown: false }], works: [] };
  }
  // ---- a city: downtowns about its middle, neighbourhood centres round them
  const jitter = origin ? ORIGIN_JITTER : CITY_JITTER;
  const first: Hub = { x: mid.x + rng.range(-1, 1) * jitter, y: mid.y + rng.range(-1, 1) * jitter, radius: m(3000), weight: 1, downtown: true };
  const hubs: Hub[] = [first];
  const most = Math.max(1, Math.min(4, options.centres));
  // The city at the origin has the downtowns asked for; the others from one up to that.
  const downtowns = origin ? most : rng.int(1, most);
  const turn = rng.range(0, Math.PI * 2);
  for (let k = 1; k < downtowns; k++) {
    const a = turn + (k * Math.PI * 2) / Math.max(1, downtowns - 1) + rng.range(-0.4, 0.4), d = rng.range(m(2200), m(3200));
    hubs.push({ x: first.x + Math.cos(a) * d, y: first.y + Math.sin(a) * d, radius: m(2000), weight: 0.85, downtown: true });
  }
  for (let k = 0; k < SUB_CENTRES; k++) {
    hubs.push({ x: first.x + rng.range(-1, 1) * m(4000), y: first.y + rng.range(-1, 1) * m(4000), radius: rng.range(m(900), m(1300)), weight: rng.range(0.5, 0.62), downtown: false });
  }
  // ---- the industry: districts away from the downtowns
  const works: Vec2[] = [];
  if (options.industry) {
    const a0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < WORKS; k++) {
      const a = a0 + k * Math.PI * 0.8, d = rng.range(m(2400), m(3000));
      works.push({ x: first.x + Math.cos(a) * d, y: first.y + Math.sin(a) * d });
    }
  }
  return { hubs, works };
}

export function planWholeMap(options: WholeMapOptions): WholeMapPlan {
  // The district cells round each cell asked about, joined once per plan (a tile asks about a few cells only).
  const blocks = new Map<string, District>();
  const blockAt = (x: number, y: number): District => {
    const cx = Math.round(x / DISTRICT), cy = Math.round(y / DISTRICT);
    const key = `${cx},${cy}`;
    let block = blocks.get(key);
    if (!block) {
      const hubs: Hub[] = [], works: Vec2[] = [];
      for (let dy = -NEAR; dy <= NEAR; dy++) {
        for (let dx = -NEAR; dx <= NEAR; dx++) {
          const d = districtOf(options, cx + dx, cy + dy);
          hubs.push(...d.hubs);
          works.push(...d.works);
        }
      }
      blocks.set(key, block = { hubs, works });
    }
    return block;
  };
  const shift = (options.density - 0.5) * 0.5;
  const salt = (options.seed % 997) * 0.37;
  const heatAt = (x: number, y: number): number => {
    if (!onMap(x, y)) return 0;
    let h = 0;
    for (const c of blockAt(x, y).hubs) {
      const dx = (x - c.x) / c.radius, dy = (y - c.y) / c.radius;
      h = Math.max(h, c.weight * Math.exp(-(dx * dx + dy * dy)));
    }
    return Math.max(MAP_FLOOR, h + shift + 0.07 * valueNoise(x / m(700) + salt, y / m(700) - salt));
  };
  const nearWorks = (p: Vec2, reach: number): boolean => blockAt(p.x, p.y).works.some((w) => Math.hypot(p.x - w.x, p.y - w.y) < reach);

  const tile = (i: number, j: number): TileCharacter => {
    const mid = tileMiddle(i, j);
    const heat = heatAt(mid.x, mid.y);
    const kind: TileKind = heat < SUBURB ? 'rural'
      : nearWorks(mid, WORKS_REACH + TILE / 4) && heat < DOWNTOWN ? 'industrial'
        : heat >= DOWNTOWN ? 'downtown' : heat >= URBAN ? 'urban' : 'suburb';
    const half = TILE / 2;
    const inTile = blockAt(mid.x, mid.y).hubs.find((c) => Math.abs(c.x - mid.x) < half * 0.7 && Math.abs(c.y - mid.y) < half * 0.7);
    const hub = inTile ? { x: inTile.x, y: inTile.y } : mid;
    const pick = new Rng(mix(options.seed, 0x5717, i, j)).float();
    let style: TileStyle;
    if (kind === 'rural') style = 'rural';
    else if (options.style !== 'mixed') style = options.style;
    else if (kind === 'downtown' || kind === 'industrial') style = 'blocks';
    else if (kind === 'urban') style = inTile && pick < 0.5 ? 'radial' : pick < 0.55 ? 'blocks' : 'grid';
    else style = pick < 0.7 ? 'organic' : 'grid';
    return { kind, style, heat, hub };
  };

  const parkSalt = (options.seed * 7919) >>> 0;
  const zoneAt = (p: Vec2, onMain: boolean): { use: ZoneUse; density: ZoneDensity } | 'park' => {
    if (!onMap(p.x, p.y)) return 'park';
    const heat = heatAt(p.x, p.y);
    // The countryside: open land, a village here and there along its roads.
    if (heat < SUBURB) return valueNoise(p.x / m(320) - salt, p.y / m(320) + salt) > 0.55 ? { use: 'residential', density: 'low' } : 'park';
    // Parks: whole patches, by a coarse noise, never in a downtown.
    const parkNoise = valueNoise(p.x / m(140) + (parkSalt % 97), p.y / m(140) - (parkSalt % 89));
    if (options.parks > 0 && heat < DOWNTOWN + 0.1 && parkNoise > 1 - options.parks * 9) return 'park';
    if (nearWorks(p, WORKS_REACH)) return { use: 'industrial', density: heat > URBAN ? 'high' : 'medium' };
    // The bid-rent curve: dense where the heat is, commerce along the main roads.
    const density: ZoneDensity = heat > DOWNTOWN ? 'high' : heat > URBAN - 0.03 ? 'medium' : 'low';
    if (heat > 0.85 || (onMain && heat > 0.35)) return { use: 'commercial', density };
    return { use: 'residential', density };
  };
  // Only the downtowns on the map (a neighbouring cell's stands past its edge and is nothing), the nearest first.
  const centresNear = (p: Vec2): Vec2[] => blockAt(p.x, p.y).hubs.filter((c) => c.downtown && onMap(c.x, c.y))
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)).map((c) => ({ x: c.x, y: c.y }));
  return { options, centresNear, heatAt, tile, zoneAt };
}
