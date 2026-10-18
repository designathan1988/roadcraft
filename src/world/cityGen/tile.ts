import type { Vec2 } from '@core/vec2';
import { TILE } from '../tiles';
import { m } from '../units';
import { TensorField } from './field';
import { tileStreets } from './network';
import type { CityPlan } from './plan';
import { type WholeMapPlan, mix } from './wholeMap';

/** ONE TILE OF THE WORLD (`wholeMap.ts`): the map's streets round it (`network.ts`, the tile and a margin, so every block reaching into it is closed whole), laid as a generated city's plan (`CityPlan`) the city's own steps read (`editor/wholeMapTile.ts`); the tile keeps what it owns. Everything here reads the seed and the tile's place only. */

export interface TilePlan {
  readonly i: number;
  readonly j: number;
  /** The plan the city's steps read (`layCity` its graph, `zoneCity` its zones). */
  readonly city: CityPlan;
  /** The tile's own stream for what is drawn on it (squares, growth). */
  readonly seed: number;
  /** Whether a place is this tile's (`tiles.ts` `OWNER`: its square, low edges in): what stands there (lots, buildings, poles, furniture) is kept by it alone. */
  owns(p: Vec2): boolean;
}

export function planTile(map: WholeMapPlan, i: number, j: number): TilePlan {
  const seed = map.options.seed;
  const x0 = i * TILE, x1 = (i + 1) * TILE, y0 = j * TILE, y1 = (j + 1) * TILE;
  const graph = tileStreets(seed, i, j, map.heatAt);
  const city: CityPlan = {
    // The steps read the plan's graph and zones; its options stand for the whole map's (no size of its own).
    options: { ...map.options, size: 'large', radius: TILE / 2 },
    field: new TensorField([], { amount: 0, scale: m(500), seed: 0 }), radius: TILE / 2,
    centres: map.centresNear({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }), graph, zoneAt: map.zoneAt,
  };
  return { i, j, city, seed: mix(seed, 0x711e, i, j), owns: (p) => p.x >= x0 && p.x < x1 && p.y >= y0 && p.y < y1 };
}
