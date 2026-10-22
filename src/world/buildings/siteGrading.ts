import type { GroundAt, PavedAt } from './foundation';
import { Digest } from '@core/digest';
import { type Pad, type TownPads, buildingPads, padLevelAt, padOf } from './pads';
import type { BuildingFloors } from './floors';
import type { GroundSince } from './cameraSolids';
import { BuildingStore } from './store';
import type { Building, BuildingId } from './types';

/** THE BUILDINGS' SITES AS THE GROUND WAS LAST GRADED TO THEM: each building's platform */

/** A world box: [minX, minY, maxX, maxY]. */
export type SiteBox = readonly [number, number, number, number];

export interface SiteGrading {
  /** The town's platforms as last put together (`rebuild`), reused while a stroke is held. */
  readonly pads: TownPads | null;
  /** What changed among the buildings since the ground was graded: the box of each site added, removed or changed */
  changedSites(buildings: BuildingStore): SiteBox[] | null;
  /** A building's platform worked out again (the roads round it moved), on its floor as the floors keep it (follow them first). */
  refresh(b: Building): void;
  /** A building's platform as worked out elsewhere (the ground's worker, `groundShape.ts` `padsOfAsk`), on its floor as the floors keep it: as `refresh` would make it. */
  take(b: Building, pad: Pad | null): void;
  /** The platforms whose bank (`bankBox`, `reach` past the bounds) a change of what they read (the floor's ground, the paving) since the last `follow` reaches, forgotten (`ground`: the floors' changes); every one when the diary cannot say where. */
  follow(buildings: BuildingStore, ground: GroundSince, reach: number): void;
  /** The town's platforms put together from each building's (`pads`); null for a town with none. */
  rebuild(buildings: BuildingStore): void;
  /** The roads or the land moved: every platform is worked out afresh, and every site read again as graded. */
  forget(buildings: BuildingStore): void;
}

/** `groundAt`: the ground a building stands on before its own grading; `pavedAt`: the footway's height; `apron` */
export function siteGrading(
  groundAt: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
  bankBox: (b: Building) => SiteBox,
  /** Each building's floor as kept for every reader (`floors.ts`), on `groundAt` and `pavedAt` */
  floors?: BuildingFloors,
): SiteGrading {
  const floorOf = floors ? (b: Building): number => floors.floorOf(b) : undefined;
  /** The buildings' platforms as last worked out, reused while a stroke is held. */
  let padsCache: TownPads | null = null;
  /** Each building's platform by record, while the roads and the land stand (`buildingPads`). */
  let padsKnown = new WeakMap<Building, Pad | null>();
  /** The buildings the ground was last graded for, by id: their record then, its site as text, and the box their bank reaches. */
  const graded = new Map<number, { ref: Building; site: number; box: SiteBox }>();
  /** What a building's site is graded from, as a digest (`core/digest.ts`), once per record */
  const siteKey = new WeakMap<Building, number>();
  const siteKeyOf = (b: Building): number => {
    let key = siteKey.get(b);
    if (key === undefined) {
      // DO NOT put it through `buildingPads` for one building: a town's filing (its cells, its map) made and dropped per site.
      if (!padsKnown.has(b)) padsKnown.set(b, padOf(b, groundAt, pavedAt, apron, floorOf));
      const pad = padsKnown.get(b);
      const digest = new Digest();
      if (pad) {
        digest.add(pad.solidCount).add(pad.stepped ? 1 : 0);
        pad.rings.forEach((ring, i) => {
          const level = pad.levels[i]!;
          digest.add(pad.water[i] ? 1 : 0).add(pad.paved[i] ? 1 : 0).add(ring.length);
          // To the millimetre, as the text was: a platform moved by less grades the same.
          for (const p of ring) digest.add(Math.round(p.x * 1000)).add(Math.round(p.y * 1000)).add(Math.round(padLevelAt(level, p.x, p.y) * 1000));
        });
      } else digest.add(-1);
      key = digest.value();
      siteKey.set(b, key);
    }
    return key;
  };
  /** The diary's revision the sites were last read at, and the town's platforms at; -1: read them all. */
  const sitesRead = BuildingStore.cursor();
  const padsBuilt = BuildingStore.cursor();
  /** The ground's version the platforms were last brought to (`follow`); -1: never. */
  let groundSeen = -1;
  /** Buildings whose platform was worked out again for the roads (`refresh`) since the town's platforms were put together. */
  const refreshed = new Set<BuildingId>();
  /** @rebuild The whole store read only the first time, after `forget`, or when the diary cannot say which buildings changed. */
  const changedSites = (buildings: BuildingStore): SiteBox[] | null => {
    const boxes: SiteBox[] = [];
    const take = (q: SiteBox): void => { boxes.push(q); };
    const grade = (b: Building): void => {
      const was = graded.get(b.id);
      if (was?.ref === b) return;
      const site = siteKeyOf(b);
      // A new record of the same site (aged, renamed): nothing to grade.
      if (was && was.site === site) { graded.set(b.id, { ref: b, site, box: was.box }); return; }
      if (was) take(was.box);
      const now = bankBox(b);
      take(now);
      graded.set(b.id, { ref: b, site, box: now });
    };
    const ids = buildings.changedFor(sitesRead);
    if (ids) {
      for (const id of ids) {
        const b = buildings.get(id);
        if (b) grade(b);
        else { const was = graded.get(id); if (was) { take(was.box); graded.delete(id); } }
      }
      return boxes.length ? boxes : null;
    }
    const seen = new Set<number>();
    for (const b of buildings.all()) {
      seen.add(b.id);
      grade(b);
    }
    for (const [id, was] of graded) if (!seen.has(id)) { take(was.box); graded.delete(id); }
    return boxes.length ? boxes : null;
  };
  return {
    get pads() { return padsCache; },
    changedSites,
    refresh(b) {
      // DO NOT forget its floor here: the floors follow the diary themselves (`floors.ts` `follow`, read before the platforms are), and a floor still right was worked out again for every building a road block reached.
      padsKnown.set(b, padOf(b, groundAt, pavedAt, apron, floorOf));
      refreshed.add(b.id);
    },
    take(b, pad) {
      padsKnown.set(b, pad);
      refreshed.add(b.id);
    },
    follow(buildings, ground, reach) {
      if (ground.version === groundSeen) return;
      const rects = groundSeen < 0 ? null : ground.rectsSince(groundSeen);
      groundSeen = ground.version;
      // DO NOT forget the whole town's platforms for a change the diary places: only those whose bank it reaches (`floors.ts` `follow`, the same changes).
      if (rects === null) { this.forget(buildings); return; }
      // `reach`: how far a bank reaches past its building's bounds (the store files the bounds).
      for (const b of buildings.nearAny(rects, reach, (b, r) => {
        const box = bankBox(b);
        return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
      })) {
        padsKnown.delete(b);
        siteKey.delete(b);
        refreshed.add(b.id);
      }
    },
    /** @rebuild The whole town's platforms filed only the first time, after `forget`, or when the diary cannot say which buildings changed. */
    rebuild(buildings) {
      const town = padsCache;
      const ids = buildings.changedFor(padsBuilt);
      if (town && ids) {
        for (const id of new Set([...ids, ...refreshed])) {
          const b = buildings.get(id);
          let pad: Pad | null = null;
          if (b) {
            if (!padsKnown.has(b)) padsKnown.set(b, padOf(b, groundAt, pavedAt, apron, floorOf));
            pad = padsKnown.get(b) ?? null;
          }
          town.put(id, pad);
        }
      } else padsCache = buildings.size > 0 ? buildingPads(buildings.all(), groundAt, pavedAt, apron, padsKnown, floorOf) : null;
      refreshed.clear();
    },
    forget(buildings) {
      padsKnown = new WeakMap();
      floors?.forgetAll();
      graded.clear();
      sitesRead.reset();
      padsBuilt.reset();
      changedSites(buildings);
    },
  };
}
