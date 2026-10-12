import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { MAP_HALF } from '../bounds';
import { m } from '../units';
import type { ZoneDensity, ZoneUse } from '../zones';
import { TensorField, valueNoise, type BasisField } from './field';
import { planarize, traceStreets, type StreetEdge, type StreetGraph, type StreetLevel } from './streets';

/**
 * A GENERATED CITY'S PLAN: what the player asks for (`CityOptions`) made into
 * the city's grain (the tensor field), its outline, its streets (a graph) and
 * its districts - what each piece of land is for and how dense.
 *
 * - Centres: one to four, each a downtown. The first is in the middle; the
 *   others round it. Density falls away from the nearest centre (the
 *   bid-rent curve of every city: towers where land is dearest, houses at
 *   the edge).
 * - Commerce lines the main streets and fills the centres; industry takes a
 *   sector of the edge, away from the centres. No block is left a park by
 *   default (the player, 2026-10-09: no parks in the middle of the blocks);
 *   `parks` above 0 brings them back.
 * - Style: the basis fields the grain is made of.
 *   - grid: one grid for the whole city, a couple of districts turned to
 *     their own angle (as a city annexes its neighbours);
 *   - organic: many small grids at varied angles and a strong noise (an old
 *     town grown street by street);
 *   - radial: rings and spokes round every centre, a grid beyond;
 *   - mixed: a radial heart and grids round it.
 *
 * Everything follows from the seed: the same options give the same city.
 */

export type CityStyle = 'grid' | 'organic' | 'radial' | 'mixed' | 'blocks';

/**
 * Block sizes of the 'blocks' style, in metres: a rectangular grid laid
 * straight, no field traced (Chicago's and Melbourne's 100 x 200 m blocks,
 * Manhattan's 80 x 274 m - en.wikipedia.org/wiki/City_block - shortened so
 * a block holds two rows of lots back to back, 22 m frontage, ~30 m deep).
 */
const BLOCK_LONG = 120;
const BLOCK_SHORT = 72;
/** Every this many blocks an avenue, every other one between a collector. */
const AVENUE_EVERY = 4;

/** A rectangular street grid over the city's square, axis-aligned, avenues every few blocks. */
function blockGrid(R: number): StreetGraph {
  const along = m(BLOCK_LONG), across = m(BLOCK_SHORT);
  const nx = Math.max(2, Math.floor((R * 1.7) / along)), ny = Math.max(2, Math.floor((R * 1.7) / across));
  const x0 = -(nx * along) / 2, y0 = -(ny * across) / 2;
  const nodes: Vec2[] = [];
  const id = (i: number, j: number): number => j * (nx + 1) + i;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) nodes.push({ x: x0 + i * along, y: y0 + j * across });
  // A line's class from its index: the edges and every AVENUE_EVERY-th line
  // avenues, halfway between them collectors, the rest local streets.
  const levelOf = (k: number, n: number): number => {
    const avenueEvery = n >= AVENUE_EVERY * 2 ? AVENUE_EVERY : n;
    if (k % avenueEvery === 0 || k === n) return 0;
    return k % (avenueEvery / 2) === 0 ? 1 : 2;
  };
  const edges: StreetEdge[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) edges.push({ a: id(i, j), b: id(i + 1, j), points: [], level: levelOf(j, ny) });
  for (let i = 0; i <= nx; i++) for (let j = 0; j < ny; j++) edges.push({ a: id(i, j), b: id(i, j + 1), points: [], level: levelOf(i, nx) });
  return { nodes, edges };
}
export type CitySize = 'small' | 'medium' | 'large';

export interface CityOptions {
  readonly seed: number;
  readonly size: CitySize;
  readonly style: CityStyle;
  /** Downtowns, 1 to 4. */
  readonly centres: number;
  /** 0 a town of houses, 1 a city of towers. */
  readonly density: number;
  /** Share of blocks made parks, 0 to 0.2. */
  readonly parks: number;
  readonly industry: boolean;
}

export const DEFAULT_CITY: CityOptions = { seed: 1, size: 'medium', style: 'blocks', centres: 2, density: 0.6, parks: 0, industry: true };

/** Road classes the levels are laid as (`roadTypes.ts` ids). */
export const LEVEL_ROAD = ['avenue', 'urban', 'local'] as const;

export interface CityPlan {
  readonly options: CityOptions;
  readonly field: TensorField;
  readonly radius: number;
  readonly centres: readonly Vec2[];
  readonly graph: StreetGraph;
  /** What the land at a point is for. */
  zoneAt(p: Vec2, onMain: boolean): { use: ZoneUse; density: ZoneDensity } | 'park';
}

const RADIUS: Record<CitySize, number> = { small: m(420), medium: m(640), large: m(880) };

export function planCity(options: CityOptions): CityPlan {
  const rng = new Rng((options.seed * 2_654_435_761) >>> 0 || 1);
  const R = Math.min(RADIUS[options.size], MAP_HALF - m(60));
  // ---- the centres
  const centres: Vec2[] = [{ x: rng.range(-R, R) * 0.08, y: rng.range(-R, R) * 0.08 }];
  for (let i = 1; i < Math.max(1, Math.min(4, options.centres)); i++) {
    const a = rng.range(0, Math.PI * 2) + i * 2.1, d = R * rng.range(0.38, 0.6);
    centres.push({ x: Math.cos(a) * d, y: Math.sin(a) * d });
  }
  // ---- the grain
  const fields: BasisField[] = [];
  const base = rng.range(0, Math.PI);
  const grid = (x: number, y: number, radius: number, angle: number, weight = 1): void => { fields.push({ kind: 'grid', x, y, radius, angle, weight }); };
  const radial = (x: number, y: number, radius: number, weight = 1): void => { fields.push({ kind: 'radial', x, y, radius, weight }); };
  let noise = { amount: 0.06, scale: m(500), seed: options.seed };
  switch (options.style) {
    case 'grid':
      grid(0, 0, R * 4, base, 0.6);
      for (let i = 0; i < 2; i++) { const a = rng.range(0, Math.PI * 2); grid(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55, R * 0.42, base + rng.range(0.25, 0.7)); }
      break;
    case 'organic':
      grid(0, 0, R * 4, base, 0.25);
      for (let i = 0; i < 7; i++) { const a = rng.range(0, Math.PI * 2), d = R * Math.sqrt(rng.float()) * 0.85; grid(Math.cos(a) * d, Math.sin(a) * d, R * rng.range(0.22, 0.38), base + rng.range(-0.9, 0.9)); }
      noise = { amount: 0.32, scale: m(260), seed: options.seed };
      break;
    case 'radial':
      grid(0, 0, R * 4, base, 0.3);
      for (const c of centres) radial(c.x, c.y, R * (c === centres[0] ? 0.55 : 0.3), 1.2);
      noise = { amount: 0.1, scale: m(400), seed: options.seed };
      break;
    case 'blocks':
      grid(0, 0, R * 4, 0, 1);
      noise = { amount: 0, scale: m(500), seed: options.seed };
      break;
    case 'mixed':
      grid(0, 0, R * 4, base, 0.45);
      radial(centres[0]!.x, centres[0]!.y, R * 0.32, 1.1);
      for (let i = 0; i < 3; i++) { const a = rng.range(0, Math.PI * 2), d = R * rng.range(0.45, 0.75); grid(Math.cos(a) * d, Math.sin(a) * d, R * 0.35, base + rng.range(-0.6, 0.6)); }
      noise = { amount: 0.14, scale: m(380), seed: options.seed };
      break;
  }
  const field = new TensorField(fields, noise);
  // ---- the outline: a circle with a ragged edge, as cities stop
  const inside = (p: Vec2): boolean => {
    const a = Math.atan2(p.y, p.x);
    const edge = R * (1 + 0.16 * valueNoise(Math.cos(a) * 2.2 + options.seed * 0.1, Math.sin(a) * 2.2));
    return Math.hypot(p.x, p.y) < edge && Math.abs(p.x) < MAP_HALF - m(40) && Math.abs(p.y) < MAP_HALF - m(40);
  };
  // ---- the streets: avenues, collectors, local streets (metres, as planners count them)
  const levels: StreetLevel[] = [
    { dsepMajor: m(330), dsepMinor: m(330), testFraction: 0.5, dstep: m(8), dlookahead: m(220), minLength: m(260), maxLength: R * 2.6, seedTries: 40 },
    { dsepMajor: m(160), dsepMinor: m(200), testFraction: 0.5, dstep: m(7), dlookahead: m(120), minLength: m(110), maxLength: R * 1.6, seedTries: 80 },
    { dsepMajor: m(68), dsepMinor: m(112), testFraction: 0.55, dstep: m(6), dlookahead: m(70), minLength: m(60), maxLength: m(520), seedTries: 160 },
  ];
  const graph = options.style === 'blocks'
    ? blockGrid(R)
    : planarize(traceStreets(field, inside, { x0: -R * 1.2, y0: -R * 1.2, x1: R * 1.2, y1: R * 1.2 }, levels, rng),
      { merge: m(14), prune: m(45), minAngle: 0.5, simplify: m(1.2), spacing: m(16) });

  // ---- the districts
  const industryAngle = rng.range(0, Math.PI * 2);
  const parkSalt = (options.seed * 7919) >>> 0;
  const zoneAt = (p: Vec2, onMain: boolean): { use: ZoneUse; density: ZoneDensity } | 'park' => {
    const near = Math.min(...centres.map((c, i) => Math.hypot(p.x - c.x, p.y - c.y) / (i === 0 ? 1 : 0.75)));
    const k = near / R; // 0 at a centre, ~1 at the edge
    // Parks: whole patches, by a coarse noise, never in the very centre.
    const parkNoise = valueNoise(p.x / m(140) + parkSalt % 97, p.y / m(140) - parkSalt % 89);
    if (options.parks > 0 && k > 0.15 && parkNoise > 1 - options.parks * 9) return 'park';
    // Industry: a sector of the edge, away from the centres.
    if (options.industry && k > 0.62) {
      let d = Math.abs(Math.atan2(p.y, p.x) - industryAngle) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < 0.55) return { use: 'industrial', density: k > 0.85 ? 'high' : 'medium' };
    }
    // The bid-rent curve, shifted by how dense a city was asked for.
    const heat = 1 - k + (options.density - 0.5) * 0.6 + valueNoise(p.x / m(220), p.y / m(220)) * 0.08;
    const density: ZoneDensity = heat > 0.72 ? 'high' : heat > 0.42 ? 'medium' : 'low';
    if (heat > 0.85 || (onMain && heat > 0.35)) return { use: 'commercial', density };
    return { use: 'residential', density };
  };
  return { options, field, radius: R, centres, graph, zoneAt };
}
