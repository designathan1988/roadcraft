import { FLAT_GROUND, GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { applyLots, forgetLotPlans, planLots } from '@world/lots';
import { Network } from '@world/network';
import { pavedHeightFrom } from '@world/paving';
import { footwayRiseAt } from '@world/roads/footwayRise';
import type { BuildingId } from '@world/buildings/types';
import { SharedMembers } from '@world/buildings/intern';
import type { SpilledItems } from '@world/buildings/spilledItems';
import type { RoadDoc, SerializedDoc } from '@world/doc';
import { smallCityPlan } from '@world/cityGen/smallCity';
import { largeCityPlan } from '@world/cityGen/largeCity';
import type { CityPlan } from '@world/cityGen/plan';
import { LOT_PLAN_VERSION, growOnLot } from '@world/growth/zoning';
import { greenCity, layCity, widenCityFootways, zoneCity } from './cityGenerator';
import { type PreparedCity, PreparedCityWriter } from './preparedCity';

/** The stream the city's buildings are grown from. */
const GROWTH_SEED = 0x5eed;

/** THE SMALL CITY OF ROADCRAFT 2.0, WHOLE, AS ONE MAP (the player, 2026-10-18: no city by tiles). Planned as 2.0 planned it (`smallCity.ts`: straight blocks, medium size), then laid out on one document: its footways, lots, green and zones, and every lot grown, on the flat ground of a new map. */
export function buildSmallCityMap(seed: number): SerializedDoc {
  return buildCityMap(smallCityPlan(seed));
}

/** THE LARGE CITY, WHOLE, AS ONE MAP: the small city's plan over a larger radius (`largeCity.ts`), laid out the same way. */
export function buildLargeCityMap(seed: number, radius?: number): SerializedDoc {
  return buildCityMap(largeCityPlan(seed, radius));
}

/** A planned city laid out as one map: its footways, lots, green and zones, and every lot grown, on the flat ground of a new map. The size is the plan's (`cityGen/plan.ts`): the probes' larger cities test the renderer's scale. */
export function buildCityMap(city: CityPlan): SerializedDoc {
  return growCity(city, null, null).toJSON();
}

/** The small or the large city of a seed made as the page opens it (`buildCityTable`). */
export function buildCityTableOf(kind: 'small' | 'large', seed: number, radius?: number, phase?: (name: string) => void): PreparedCity {
  return buildCityTable(kind === 'large' ? largeCityPlan(seed, radius) : smallCityPlan(seed), phase);
}

/** Records held as objects while the city grows, past which the older are spilled into its table (`SpilledItems.spill`). */
const SPILL_AT = 4096;
/** The newest records kept as objects at a spill: the block growing now reads them as its neighbours. */
const SPILL_KEEP = 1024;

/**
 * THE CITY AS THE PAGE OPENS IT, MADE WITHOUT HOLDING ITS BUILDINGS AS OBJECTS (`cityGen.worker.ts`): the very city `buildCityMap` makes
 * (the same records, in the same order) prepared as `prepareCity` prepares it, but its buildings spilled into tables as they grow - the
 * table the growth reads its older neighbours back from, and the page's (`PreparedCityWriter`). DO NOT grow the whole city as objects
 * and prepare it after: ~20 KB of JS heap a building, twice over while it was prepared, and the city of 160,000 buildings took its
 * worker to 5.6 GB, past the V8 cage the worker shares with its page (2026-10-22). `phase`: told as each step ends (the scale probes).
 */
export function buildCityTable(city: CityPlan, phase?: (name: string) => void): PreparedCity {
  // One table of shared members for both: the page's records are the growth's migrated, their members made canonical once.
  const shared = new SharedMembers();
  const page = new PreparedCityWriter(shared);
  const doc = growCity(city, shared, (items, last) => {
    if (!last && items.heldCount < SPILL_AT) return;
    page.add(items.spill(last ? 0 : SPILL_KEEP));
    shared.end();
    items.endBatch();
    page.endBatch();
    phase?.('spilled');
  }, phase);
  // The growth's network and elevation let go with `growCity`'s scope: only the document lives on to be written out.
  const data = doc.toJSONBuildingsApart();
  phase?.('written');
  return { data, buildings: page.finish() };
}

/** A planned city laid out and grown on one document. `spill`: told after each building grown and once at the end (`last`), with the store's items spilled to a table (`BuildingStore.spillToTable`, its members shared by `shared`); null: every record kept as an object. */
function growCity(city: CityPlan, shared: SharedMembers | null, spill: ((items: SpilledItems, last: boolean) => void) | null, phase?: (name: string) => void): RoadDoc {
  const doc = layCity(city);
  // The city is written out and this document thrown away: its buildings are interned where they are read (`prepareCity` settles every one again before its table, the page reads the table). DO NOT share them here as well: the grown buildings were interned twice, 1.6 s of the large city's 9.5 s generation spent in `intern` (profile, 2026-10-21).
  doc.buildings.internShared = false;
  const items = spill ? doc.buildings.spillToTable(shared ?? undefined) : null;
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  phase?.('roads');
  applyLots(doc, planLots(doc, net));
  // The land is planned once: its planner let go, not kept with the network through the growth.
  forgetLotPlans(net);
  phase?.('lots');
  greenCity(doc, net, (city.options.seed * 0x711e) >>> 0);
  phase?.('green');
  // The roads as they stand for the zones (a rebuild finds what changed, nothing when nothing did).
  net.rebuild();
  zoneCity(doc, net, city);
  phase?.('zones');
  growLots(doc, net, items && spill ? () => spill(items, false) : null);
  if (items && spill) spill(items, true);
  phase?.('grown');
  return doc;
}

/** Every open lot of the city grown, on the flat ground of a new map and the paving its streets lay on it; `grew`: told after each building. */
function growLots(doc: RoadDoc, net: Network, grew: (() => void) | null): void {
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
      grew?.();
    } else if (doc.openLots.count(refused) === 0) break;
  }
}
