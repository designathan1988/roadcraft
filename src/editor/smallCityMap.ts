import { FLAT_GROUND, GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { applyLots, planLots } from '@world/lots';
import { Network } from '@world/network';
import { pavedHeightFrom } from '@world/paving';
import { footwayRiseAt } from '@world/roads/footwayRise';
import type { BuildingId } from '@world/buildings/types';
import type { SerializedDoc } from '@world/doc';
import { smallCityPlan } from '@world/cityGen/smallCity';
import { largeCityPlan } from '@world/cityGen/largeCity';
import type { CityPlan } from '@world/cityGen/plan';
import { LOT_PLAN_VERSION, growOnLot } from '@world/growth/zoning';
import { greenCity, layCity, widenCityFootways, zoneCity } from './cityGenerator';

/** The stream the city's buildings are grown from. */
const GROWTH_SEED = 0x5eed;

/** THE SMALL CITY OF ROADCRAFT 2.0, WHOLE, AS ONE MAP (the player, 2026-10-18: no city by tiles). Planned as 2.0 planned it (`smallCity.ts`: straight blocks, medium size), then laid out on one document: its footways, lots, green and zones, and every lot grown, on the flat ground of a new map. */
export function buildSmallCityMap(seed: number): SerializedDoc {
  return buildCityMap(smallCityPlan(seed));
}

/** THE LARGE CITY, WHOLE, AS ONE MAP: the small city's plan over a larger radius (`largeCity.ts`), laid out the same way. */
export function buildLargeCityMap(seed: number): SerializedDoc {
  return buildCityMap(largeCityPlan(seed));
}

/** A planned city laid out as one map: its footways, lots, green and zones, and every lot grown, on the flat ground of a new map. The size is the plan's (`cityGen/plan.ts`): the probes' larger cities test the renderer's scale. */
export function buildCityMap(city: CityPlan): SerializedDoc {
  const doc = layCity(city);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, (city.options.seed * 0x711e) >>> 0);
  // The roads as they stand for the zones (a rebuild finds what changed, nothing when nothing did).
  net.rebuild();
  zoneCity(doc, net, city);
  // The flat ground of a new map, and the paving its streets lay on it (as the renderer reads it, `renderer.ts` `pavedHeightAt`). `FLAT_GROUND` lets the solve skip the ground reads of every station (level ground: every sample the same).
  const ground = FLAT_GROUND;
  const elevation = buildRoadElevation(net, FLAT_GROUND);
  const pavedAt = (x: number, y: number): number => (elevation.has(GROUND_ONLY) ? pavedHeightFrom(elevation, GROUND_ONLY, (px, py) => footwayRiseAt(net, px, py), x, y) : NaN);
  const refused = new Set<number>();
  const open = doc.openLots.count(refused);
  for (let guard = 0; guard < open * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: ground, pavedAt }, refused, GROWTH_SEED);
    if (id !== null) {
      // Stamped as the page stamps a building grown (`main.ts` `growthAnswered`), at the city's first minute.
      const fresh = doc.buildings.get(id as BuildingId)!;
      doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
    } else if (doc.openLots.count(refused) === 0) break;
  }
  return doc.toJSON();
}
