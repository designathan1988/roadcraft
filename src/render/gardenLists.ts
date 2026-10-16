import { Digest } from '@core/digest';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';
import { CellFiling } from '@world/cells';
import type { ActiveTiles } from './activeTiles';
import type { GardenChange, GardenPlant } from './gardens';
import type { GroundRecord, Rect } from './groundChanges';

/** DO NOT hand the gardens every planted building's list at every change */

export interface GardenLists {
  /** The lists to place and to take away since the last call, null when none. */
  update(buildings: BuildingStore, settled: boolean): GardenChange | null;
}

/** A planted building: its record, its plants digested, its bank, and its plants on the ground (once placed) with the ground change they follow. */
interface Site { b: Building; key: number; box: Rect; plants: readonly GardenPlant[] | null; seen: number }

/** `ground`: where and when the drawn ground changed; `active`: the streamed world's active tiles, the only ones whose buildings' gardens are planted here (`activeTiles.ts`; none, every building's) */
export function gardenLists(
  ground: GroundRecord,
  bankBox: (b: Building) => Rect,
  plantsOf: (b: Building) => readonly GardenPlant[],
  active?: ActiveTiles,
): GardenLists {
  /** Where the active tiles moved since the last update: the buildings there taken in or let go. */
  const moves = active?.reader();
  /** DO NOT key it by the JSON text: a string kept for every building with a garden. */
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
    // A building of the kept ring round the active tiles is the far levels' (as its cell's, `BuildingLayer.setActive`): no garden here.
    const key = b && (!active || active.has(b.x, b.y)) ? plantKeyOf(b) : -1;
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
  /** @rebuild Every building of the store and every site taken in again: the first time, or when what changed cannot be said. */
  const takeAll = (buildings: BuildingStore): void => {
    const seen = new Set<BuildingId>();
    for (const b of buildings.all()) { seen.add(b.id); take(b.id, b); }
    for (const id of [...sites.keys()]) if (!seen.has(id)) take(id, undefined);
  };
  /** The whole store read only the first time or when the diary cannot say which buildings changed (a map loaded or cleared). */
  const follow = (buildings: BuildingStore): void => {
    if (read === buildings.revision) return;
    const ids = read < 0 ? null : buildings.changedSince(read);
    if (ids) for (const id of ids) take(id, buildings.get(id));
    else takeAll(buildings);
    read = buildings.revision;
  };
  /** The buildings of the tiles that came into the active region or left it, taken in or let go (every building when it moved everywhere). */
  const followActive = (buildings: BuildingStore): void => {
    const rects = moves?.take();
    if (rects === undefined) return;
    if (rects === null) { takeAll(buildings); return; }
    for (const r of rects) for (const b of buildings.near(r[0], r[1], r[2], r[3])) take(b.id, b);
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
      // Every placed site was placed at `groundRead` or before
      for (const id of banks.idsMeetingAny(rects)) if (sites.get(id)!.plants) pending.add(id);
      return;
    }
    for (const [id, site] of sites) check(id, site);
  };

  return {
    update(buildings, settled) {
      follow(buildings);
      followActive(buildings);
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
