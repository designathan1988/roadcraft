import { Digest } from '@core/digest';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';
import { CellFiling } from '@world/cells';
import type { GardenChange, GardenPlant } from './gardens';
import type { GroundRecord, Rect } from './groundChanges';

/**
 * WHICH PLANTS THE BUILDINGS' GARDENS HOLD, building by building, and which
 * lists must be placed or taken away (`render/renderer.ts` hands the change to
 * `gardens.ts`). A building's plants are sampled on the ground again only when
 * they changed or a change of the ground reached its bank. Out of the
 * renderer, and with no three, so the work of one building more can be
 * counted (`tests/scale/buildingEdit.spec.ts`).
 *
 * WHAT CHANGED, NOT THE TOWN: a building more costs that building - its
 * record read by the id the diary gives, its bank found by the ground's
 * changes through the world's cells (`world/cells.ts`), and only its list
 * handed on. DO NOT hand the gardens every planted building's list at every
 * change (it was: the gardens then walked the town's lists to find the one
 * that came, a pass over the town per building grown, `building+1:gardens`
 * x14,02 - quadratic).
 */

export interface GardenLists {
  /**
   * The lists to place and to take away since the last call, null when none.
   * `settled`: the ground is the one the plants will stand on (no stroke held,
   * no world being built); until it is, nothing is placed.
   */
  update(buildings: BuildingStore, settled: boolean): GardenChange | null;
}

/** A planted building: its record, its plants digested, its bank, and its plants on the ground (once placed) with the ground change they follow. */
interface Site { b: Building; key: number; box: Rect; plants: readonly GardenPlant[] | null; seen: number }

/**
 * `ground`: where and when the drawn ground changed (with `rectsSince`, the
 * banks it reached are found by place; without, every placed bank is asked);
 * `bankBox`: the box a building's bank reaches; `plantsOf`: a building's
 * plants on the drawn ground.
 */
export function gardenLists(
  ground: GroundRecord,
  bankBox: (b: Building) => Rect,
  plantsOf: (b: Building) => readonly GardenPlant[],
): GardenLists {
  /**
   * The plants of the buildings' gardens, as `plantsOf` reads them: each
   * building's plant elements and where it stands, digested (`Digest.addPlain`), once per
   * record (a record is replaced on any change, its age included); -1: no plants. DO NOT key it by
   * the JSON text: a string kept for every building with a garden.
   */
  const plantKey = new WeakMap<Building, number>();
  const plantKeyOf = (b: Building): number => {
    let key = plantKey.get(b);
    if (key === undefined) {
      const plants = (b.elements ?? []).filter((el: { kind: string }) => el.kind === 'tree' || el.kind === 'shrub' || el.kind === 'hedge' || el.kind === 'flowers');
      key = plants.length ? new Digest().add(b.x).add(b.y).add(b.rotation).addPlain(plants).value() : -1;
      plantKey.set(b, key);
    }
    return key;
  };
  /** The planted buildings, taken in by the ids the diary gives (`BuildingStore.changedSince`), and filed by their banks. */
  const sites = new Map<BuildingId, Site>();
  const banks = new CellFiling<BuildingId, Site>();
  /** The buildings whose plants are to be placed (again): new or changed, or the ground moved under them. */
  const pending = new Set<BuildingId>();
  /** The lists placed before that are to be taken away. */
  const gone: (readonly GardenPlant[])[] = [];
  let read = -1;
  let groundRead = -1;
  /** A building's record taken in. */
  const take = (id: BuildingId, b: Building | undefined): void => {
    const key = b ? plantKeyOf(b) : -1;
    const site = sites.get(id);
    if (key < 0) {
      if (!site) return;
      if (site.plants) gone.push(site.plants);
      sites.delete(id);
      banks.remove(id);
      pending.delete(id);
      return;
    }
    if (site?.key === key) { site.b = b!; return; }
    const box = bankBox(b!);
    if (site) {
      if (site.plants) gone.push(site.plants);
      Object.assign(site, { b, key, box, plants: null });
      banks.remove(id);
      banks.file(id, site, box);
    } else {
      const fresh: Site = { b: b!, key, box, plants: null, seen: -1 };
      sites.set(id, fresh);
      banks.file(id, fresh, box);
    }
    pending.add(id);
  };
  /** @rebuild The whole store read only the first time or when the diary cannot say which buildings changed (a map loaded or cleared). */
  const follow = (buildings: BuildingStore): void => {
    if (read === buildings.revision) return;
    const ids = read < 0 ? null : buildings.changedSince(read);
    if (ids) for (const id of ids) take(id, buildings.get(id));
    else {
      const seen = new Set<BuildingId>();
      for (const b of buildings.all()) { seen.add(b.id); take(b.id, b); }
      for (const id of [...sites.keys()]) if (!seen.has(id)) take(id, undefined);
    }
    read = buildings.revision;
  };
  /** A placed site the ground moved under since it was placed: placed again. */
  const check = (id: BuildingId, site: Site): void => {
    if (site.plants && ground.touches(site.seen, site.box)) pending.add(id);
  };
  /** @rebuild The banks a change of the ground since the last look reached; every placed bank only when the record cannot say where. */
  const groundMoved = (): void => {
    const version = ground.version;
    if (version === groundRead) return;
    const since = groundRead;
    groundRead = version;
    if (since < 0) return;
    const rects = ground.rectsSince ? ground.rectsSince(since) : null;
    if (rects) {
      // Every placed site was placed at `groundRead` or before (`update` reads
      // the ground first), so a change after `since` met by its bank moved
      // its ground: no asking the diary back to when it was placed.
      for (const rect of rects) for (const id of banks.idsMeeting(rect)) if (sites.get(id)!.plants) pending.add(id);
      return;
    }
    for (const [id, site] of sites) check(id, site);
  };

  return {
    update(buildings, settled) {
      follow(buildings);
      groundMoved();
      if (!settled || (pending.size === 0 && gone.length === 0)) return null;
      const added: (readonly GardenPlant[])[] = [];
      for (const id of pending) {
        const site = sites.get(id);
        if (!site) continue;
        if (site.plants) gone.push(site.plants);
        site.plants = plantsOf(site.b);
        site.seen = ground.version;
        added.push(site.plants);
      }
      pending.clear();
      return { added, removed: gone.splice(0) };
    },
  };
}
