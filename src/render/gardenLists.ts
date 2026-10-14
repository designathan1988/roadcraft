import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';
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

/** A planted building: its record, its plants as text, its bank, and its plants on the ground with the ground change they follow. */
interface Site { b: Building; text: string; box: Rect; plants: readonly GardenPlant[] | null; seen: number }

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
  /**
   * The planted buildings, kept from one change to the next and taken in by
   * the ids the diary gives (`BuildingStore.changedSince`): one building more
   * costs that building. NOT the whole store read at every change of one
   * building, twice, with every bank tested against the ground's changes
   * (docs/AUDITORIA-2026-10-14.md C2; `building+1:gardens` x14,02).
   */
  const sites = new Map<BuildingId, Site>();
  let read = -1;
  let serial = 0;
  /** Where the gardens' plants stand, building by building; null until asked after a change. */
  let area: Rect[] | null = [];
  /** A building's record taken in; true when its garden changed. */
  const take = (id: BuildingId, b: Building | undefined): boolean => {
    const text = b ? plantTextOf(b) : '';
    const site = sites.get(id);
    if (!text) return sites.delete(id);
    if (site?.text === text) { site.b = b!; return false; }
    if (site) Object.assign(site, { b, text, box: bankBox(b!), plants: null });
    else sites.set(id, { b: b!, text, box: bankBox(b!), plants: null, seen: -1 });
    return true;
  };
  /** @rebuild The whole store read only the first time or when the diary cannot say which buildings changed (a map loaded or cleared). */
  const follow = (buildings: BuildingStore): void => {
    if (read === buildings.revision) return;
    const ids = read < 0 ? null : buildings.changedSince(read);
    let changed = false;
    if (ids) for (const id of ids) changed = take(id, buildings.get(id)) || changed;
    else {
      const seen = new Set<BuildingId>();
      for (const b of buildings.all()) { seen.add(b.id); changed = take(b.id, b) || changed; }
      for (const id of [...sites.keys()]) if (!seen.has(id)) changed = sites.delete(id) || changed;
    }
    read = buildings.revision;
    if (changed) { serial++; area = null; }
  };
  const onGround = new GroundDependant(ground);

  return {
    update(buildings, settled) {
      follow(buildings);
      area ??= [...sites.values()].map((site) => site.box);
      if (!settled || !onGround.stale(String(serial), area)) return null;
      // Each building's plants sampled on the ground again only when they
      // changed or a change of the ground reached its bank (none since: the
      // diary answers at once, `changes.ts`). Each building's list kept as it
      // is: the gardens are packed per list (`gardens.ts` `gardenPack`), a
      // list unchanged is not placed again.
      const plants: (readonly GardenPlant[])[] = [];
      for (const site of sites.values()) {
        if (!site.plants || ground.touches(site.seen, site.box)) {
          site.plants = plantsOf(site.b);
          site.seen = ground.version;
        }
        plants.push(site.plants);
      }
      return plants;
    },
  };
}
