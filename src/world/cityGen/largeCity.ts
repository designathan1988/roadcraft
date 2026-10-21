import { DEFAULT_CITY, type CityPlan, planCity } from './plan';
import { m } from '../units';

/** THE LARGE CITY: the small city of Roadcraft 2.0 (`smallCity.ts`) made bigger - the same plan, the same 'blocks' style, the same straight grid, zones and squares, over a larger radius. Every block is built; no block is left as bare grass. */

/** The large city's radius: its grid spans 1.7 radii, about 2.7 km across (the small city's 1.1 km). */
export const LARGE_CITY_RADIUS = m(1_600);

/** The large city of a seed (made once a city is asked for, `cityGen.worker.ts`: nothing kept between them); `radius`: the same city over another radius, its density kept (the scale steps: ~2.8 km for ~25 000 buildings, ~4.7 km for ~70 000, ~7.9 km for ~200 000 on the 14-tile map). */
export function largeCityPlan(seed: number, radius: number = LARGE_CITY_RADIUS): CityPlan {
  return planCity({ ...DEFAULT_CITY, seed, size: 'large', radius });
}
