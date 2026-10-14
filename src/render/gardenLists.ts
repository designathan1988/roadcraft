import type { BuildingStore } from '@world/buildings/store';
import type { Building } from '@world/buildings/types';
import type { GardenPlant } from './gardens';
import { GroundDependant, type GroundRecord, type Rect } from './groundChanges';

/**
 * WHICH PLANTS THE BUILDINGS' GARDENS HOLD, building by building, and when
 * they must be placed again (`render/renderer.ts` hands the lists to
 * `gardens.ts`). A building's plants are sampled on the ground again only when
 * they changed or a change of the ground reached its bank; the gardens are
 * placed again only when a building's plants changed or the ground moved under
 * one of them. Out of the renderer, and with no three, so the work of one
 * building more can be counted (`tests/scale/buildingEdit.spec.ts`).
 */

export interface GardenLists {
  /**
   * Each planted building's list when the gardens must be placed again, null
   * while they stand. `settled`: the ground is the one the plants will stand
   * on (no stroke held, no world being built); until it is, nothing is placed.
   */
  update(buildings: BuildingStore, settled: boolean): (readonly GardenPlant[])[] | null;
}

/**
 * `ground`: where and when the drawn ground changed; `bankBox`: the box a
 * building's bank reaches; `plantsOf`: a building's plants on the drawn ground.
 */
export function gardenLists(
  ground: GroundRecord,
  bankBox: (b: Building) => Rect,
  plantsOf: (b: Building) => readonly GardenPlant[],
): GardenLists {
  /**
   * The plants of the buildings' gardens, as `plantsOf` reads them: each
   * building's plant elements and where it stands, as text, once per record
   * (a record is replaced on any change, its age included). The whole town's
   * plants were written out as one text at every change of any building.
   */
  const plantText = new WeakMap<Building, string>();
  const plantTextOf = (b: Building): string => {
    let text = plantText.get(b);
    if (text === undefined) {
      const plants = (b.elements ?? []).filter((el: { kind: string }) => el.kind === 'tree' || el.kind === 'shrub' || el.kind === 'hedge' || el.kind === 'flowers');
      text = plants.length ? JSON.stringify([b.x, b.y, b.rotation, plants]) : '';
      plantText.set(b, text);
    }
    return text;
  };
  /** Each planted building's plants on the drawn ground, the text they were read from and the ground change they follow. */
  const gardenCache = new Map<number, { readonly text: string; readonly seen: number; readonly plants: readonly GardenPlant[] }>();
  /** The gardens as last read: each planted building's text and bank; a serial moved when one changed. */
  const plantedSites = new Map<number, { readonly text: string; readonly box: Rect }>();
  let plantsFor = -1;
  let plantsSerial = 0;
  /** Where the gardens' plants stand, building by building. */
  let plantsArea: Rect[] = [];
  const plantSignature = (buildings: BuildingStore): string => {
    if (plantsFor === buildings.revision) return String(plantsSerial);
    plantsFor = buildings.revision;
    let changed = false;
    const seen = new Set<number>();
    for (const b of buildings.all()) {
      const text = plantTextOf(b);
      if (!text) continue;
      seen.add(b.id);
      if (plantedSites.get(b.id)?.text === text) continue;
      plantedSites.set(b.id, { text, box: bankBox(b) });
      changed = true;
    }
    for (const id of [...plantedSites.keys()]) if (!seen.has(id)) { plantedSites.delete(id); changed = true; }
    if (changed) {
      plantsSerial++;
      plantsArea = [...plantedSites.values()].map((site) => site.box);
    }
    return String(plantsSerial);
  };
  const onGround = new GroundDependant(ground);

  return {
    update(buildings, settled) {
      const gardenKey = plantSignature(buildings);
      if (!settled || !onGround.stale(gardenKey, plantsArea)) return null;
      // Each building's plants sampled on the ground again only when they
      // changed or a change of the ground reached its bank.
      // Each building's list kept as it is: the gardens are packed per list
      // (`gardens.ts` `gardenPack`), a list unchanged is not placed again.
      const plants: (readonly GardenPlant[])[] = [];
      const seen = new Set<number>();
      for (const b of buildings.all()) {
        const text = plantTextOf(b);
        if (!text) continue;
        seen.add(b.id);
        const was = gardenCache.get(b.id);
        if (was && was.text === text && !ground.touches(was.seen, bankBox(b))) {
          plants.push(was.plants);
          continue;
        }
        const own = plantsOf(b);
        gardenCache.set(b.id, { text, seen: ground.version, plants: own });
        plants.push(own);
      }
      for (const id of [...gardenCache.keys()]) if (!seen.has(id)) gardenCache.delete(id);
      return plants;
    },
  };
}
