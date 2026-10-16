import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { MAP_HALF, PLATE_SIZE } from '../bounds';
import { m } from '../units';
import type { ZoneDensity, ZoneUse } from '../zones';
import { valueNoise } from './field';
import type { CityOptions, CityStyle } from './plan';

/** THE WHOLE MAP AS ONE CITY (rewrite F7): the map cut into tiles of 1,024 m, each planned and built on its own (`tile.ts`, `editor/wholeMapTile.ts`) from the seed and its own place alone, so the tiles can be made in any order on any number of workers and come out the same. What the tiles share is decided here, by rules that read only the seed and the tiles' coordinates: the border avenues on every tile edge, the gates where streets cross them (the same for a whole row or column of tiles, so a street goes straight on into the next tile), and the city's districts - its centres, how dense each place is, its industry and its parks. */

/** A tile's side: half a plate, the grid the rewrite counts in. */
export const TILE = PLATE_SIZE / 2;
/** Tiles along each side of the map. */
export const TILES = Math.round((MAP_HALF * 2) / TILE);
/** The avenue round the map's rim stands this far inside it (`MAP_MARGIN` and a row of lots outside it). */
const EDGE = m(64);
/** No gate this near a tile's corner: the corner is the two border avenues' junction. */
const CORNER = m(110);
/** Distance between two gates of a border, at least and at most. */
const GATE_MIN = m(140);
const GATE_MAX = m(260);
/** Share of the gates that are avenues: a straight avenue across the map every few kilometres. */
const AVENUE_GATES = 0.2;

/** The whole map's options: a generated city's (`CityOptions`) without a size; style 'mixed' picks a style per tile. */
export type WholeMapOptions = Omit<CityOptions, 'size' | 'radius'>;

/** What the whole map asks when the player asks only for it: a style per tile, three centres, some parks. */
export const WHOLE_MAP_DEFAULTS: Pick<WholeMapOptions, 'style' | 'centres' | 'parks'> = { style: 'mixed', centres: 3, parks: 0.05 };

/** The line of border `k` (0 to `TILES`) along either axis: the tiles' edges, the outer two pulled in from the rim. */
export function borderLine(k: number): number {
  if (k <= 0) return -MAP_HALF + EDGE;
  if (k >= TILES) return MAP_HALF - EDGE;
  return -MAP_HALF + k * TILE;
}

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

/** The gates of row or column `k` (`axis` 0: across the borders x = const of row k, at these y; 1: across y = const of column k, at these x). */
export function gatesOf(seed: number, axis: 0 | 1, k: number): Gate[] {
  const lo = borderLine(k) + CORNER, hi = borderLine(k + 1) - CORNER;
  const rng = new Rng(mix(seed, 0x6a7e, axis, k));
  const out: Gate[] = [];
  for (let at = lo + rng.range(0, GATE_MAX - GATE_MIN); at <= hi; at += rng.range(GATE_MIN, GATE_MAX)) {
    out.push({ at, level: rng.float() < AVENUE_GATES ? 0 : 1 });
  }
  return out;
}

/** A centre of the city: how strongly it draws and how far. */
interface Hub { readonly x: number; readonly y: number; readonly radius: number; readonly weight: number }

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
/** Centres of neighbourhoods besides the downtowns. */
const SUB_CENTRES = 6;
/** Industrial districts, and their reach. */
const WORKS = 2;
const WORKS_REACH = m(700);

export interface WholeMapPlan {
  readonly options: WholeMapOptions;
  readonly centres: readonly Vec2[];
  /** How built up a place is: about 1 at a downtown, 0 in the countryside. */
  heatAt(x: number, y: number): number;
  tile(i: number, j: number): TileCharacter;
  /** What the land at a point is for (`CityPlan.zoneAt`). */
  zoneAt(p: Vec2, onMain: boolean): { use: ZoneUse; density: ZoneDensity } | 'park';
}

/** The tile's middle. */
export const tileMiddle = (i: number, j: number): Vec2 => ({ x: (borderLine(i) + borderLine(i + 1)) / 2, y: (borderLine(j) + borderLine(j + 1)) / 2 });

export function planWholeMap(options: WholeMapOptions): WholeMapPlan {
  const rng = new Rng(mix(options.seed, 0xc17e));
  // ---- the centres: downtowns about the middle, neighbourhood centres round them
  const hubs: Hub[] = [{ x: rng.range(-1, 1) * m(600), y: rng.range(-1, 1) * m(600), radius: m(3000), weight: 1 }];
  const downtowns = Math.max(1, Math.min(4, options.centres));
  const turn = rng.range(0, Math.PI * 2);
  for (let k = 1; k < downtowns; k++) {
    const a = turn + (k * Math.PI * 2) / Math.max(1, downtowns - 1) + rng.range(-0.4, 0.4), d = rng.range(m(2200), m(3200));
    hubs.push({ x: hubs[0]!.x + Math.cos(a) * d, y: hubs[0]!.y + Math.sin(a) * d, radius: m(2000), weight: 0.85 });
  }
  for (let k = 0; k < SUB_CENTRES; k++) {
    hubs.push({ x: rng.range(-1, 1) * m(4000), y: rng.range(-1, 1) * m(4000), radius: rng.range(m(900), m(1300)), weight: rng.range(0.5, 0.62) });
  }
  // ---- the industry: districts away from the downtowns
  const works: Vec2[] = [];
  if (options.industry) {
    const a0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < WORKS; k++) {
      const a = a0 + k * Math.PI * 0.8, d = rng.range(m(2400), m(3000));
      works.push({ x: hubs[0]!.x + Math.cos(a) * d, y: hubs[0]!.y + Math.sin(a) * d });
    }
  }
  const shift = (options.density - 0.5) * 0.5;
  const salt = (options.seed % 997) * 0.37;
  const heatAt = (x: number, y: number): number => {
    let h = 0;
    for (const c of hubs) {
      const dx = (x - c.x) / c.radius, dy = (y - c.y) / c.radius;
      h = Math.max(h, c.weight * Math.exp(-(dx * dx + dy * dy)));
    }
    return h + shift + 0.07 * valueNoise(x / m(700) + salt, y / m(700) - salt);
  };
  const nearWorks = (p: Vec2, reach: number): boolean => works.some((w) => Math.hypot(p.x - w.x, p.y - w.y) < reach);

  const tile = (i: number, j: number): TileCharacter => {
    const mid = tileMiddle(i, j);
    const heat = heatAt(mid.x, mid.y);
    const kind: TileKind = heat < SUBURB ? 'rural'
      : nearWorks(mid, WORKS_REACH + TILE / 4) && heat < DOWNTOWN ? 'industrial'
        : heat >= DOWNTOWN ? 'downtown' : heat >= URBAN ? 'urban' : 'suburb';
    const half = TILE / 2;
    const inTile = hubs.find((c) => Math.abs(c.x - mid.x) < half * 0.7 && Math.abs(c.y - mid.y) < half * 0.7);
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
  return { options, centres: hubs.slice(0, downtowns).map((c) => ({ x: c.x, y: c.y })), heatAt, tile, zoneAt };
}
