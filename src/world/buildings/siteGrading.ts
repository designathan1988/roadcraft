import type { GroundAt, PavedAt } from './foundation';
import { type BuildingPads, type Pad, buildingPads } from './pads';
import type { BuildingStore } from './store';
import type { Building } from './types';

/**
 * THE BUILDINGS' SITES AS THE GROUND WAS LAST GRADED TO THEM: each building's
 * platform (`buildingPads`), the platforms of the whole town for the ground's
 * shaping, and which sites changed since (`render/renderer.ts` cuts and fills
 * the ground round them). Out of the renderer so the work of one building more
 * can be counted (`tests/scale/buildingEdit.spec.ts`).
 */

/** A world box: [minX, minY, maxX, maxY]. */
export type SiteBox = readonly [number, number, number, number];

export interface SiteGrading {
  /** The town's platforms as last put together (`rebuild`), reused while a stroke is held. */
  readonly pads: BuildingPads | null;
  /** What changed among the buildings since the ground was graded: the box of every site added, removed or changed, or null when none did. */
  changedSites(buildings: BuildingStore): SiteBox | null;
  /** A building's platform worked out again (the roads round it moved). */
  refresh(b: Building): void;
  /** A building's platform worked out if it is not known; true when it was worked out now. */
  ensure(b: Building): boolean;
  /** The town's platforms put together from each building's (`pads`); null for a town with none. */
  rebuild(buildings: BuildingStore): void;
  /** The roads or the land moved: every platform is worked out afresh, and every site read again as graded. */
  forget(buildings: BuildingStore): void;
}

/**
 * `groundAt`: the ground a building stands on before its own grading;
 * `pavedAt`: the footway's height; `apron`: the level margin round each
 * footprint (`buildingPads`); `bankBox`: the box a building's bank reaches.
 */
export function siteGrading(
  groundAt: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
  bankBox: (b: Building) => SiteBox,
): SiteGrading {
  /** The buildings' platforms as last worked out, reused while a stroke is held. */
  let padsCache: BuildingPads | null = null;
  /** Each building's platform by record, while the roads and the land stand (`buildingPads`). */
  let padsKnown = new WeakMap<Building, Pad | null>();
  /** The buildings the ground was last graded for, by id: their record then, its site as text, and the box their bank reaches. */
  const graded = new Map<number, { ref: Building; site: string; box: SiteBox }>();
  /**
   * What a building's site is graded from, as text, once per record: the
   * platform the grading reads (`buildingPads`, kept in `padsKnown` for the
   * grading itself) - each ring's corners, the platform's height at each,
   * water, paving, its solid blocks and split levels - and nothing else of
   * the record. A result is reused while the inputs its build reads are the
   * same (Bazel's action cache). The whole record (less its age and name)
   * was compared before: a storey added, a facade or a roof changed, the
   * town's ageing - a record every few seconds - re-graded the lot and set
   * off everything that stands on the ground round it.
   */
  const siteText = new WeakMap<Building, string>();
  const siteTextOf = (b: Building): string => {
    let text = siteText.get(b);
    if (text === undefined) {
      if (!padsKnown.has(b)) buildingPads([b], groundAt, pavedAt, apron, padsKnown);
      const pad = padsKnown.get(b);
      text = '';
      if (pad) {
        text = `${pad.solidCount}|${pad.stepped ? 1 : 0}`;
        pad.rings.forEach((ring, i) => {
          const level = pad.levels[i]!;
          text += `|${pad.water[i] ? 'w' : ''}${pad.paved[i] ? 'p' : ''}`;
          for (const p of ring) text += `;${p.x.toFixed(3)},${p.y.toFixed(3)},${level(p.x, p.y).toFixed(3)}`;
        });
      }
      siteText.set(b, text);
    }
    return text;
  };
  const changedSites = (buildings: BuildingStore): SiteBox | null => {
    let box: [number, number, number, number] | null = null;
    const take = (q: SiteBox): void => {
      box = box ? [Math.min(box[0], q[0]), Math.min(box[1], q[1]), Math.max(box[2], q[2]), Math.max(box[3], q[3])] : [...q];
    };
    const seen = new Set<number>();
    for (const b of buildings.all()) {
      seen.add(b.id);
      const was = graded.get(b.id);
      if (was?.ref === b) continue;
      const site = siteTextOf(b);
      // A new record of the same site (aged, renamed): nothing to grade.
      if (was && was.site === site) { graded.set(b.id, { ref: b, site, box: was.box }); continue; }
      if (was) take(was.box);
      const now = bankBox(b);
      take(now);
      graded.set(b.id, { ref: b, site, box: now });
    }
    for (const [id, was] of graded) if (!seen.has(id)) { take(was.box); graded.delete(id); }
    return box;
  };
  return {
    get pads() { return padsCache; },
    changedSites,
    refresh(b) {
      padsKnown.delete(b);
      buildingPads([b], groundAt, pavedAt, apron, padsKnown);
    },
    ensure(b) {
      if (padsKnown.has(b)) return false;
      buildingPads([b], groundAt, pavedAt, apron, padsKnown);
      return true;
    },
    rebuild(buildings) {
      padsCache = buildings.size > 0 ? buildingPads(buildings.all(), groundAt, pavedAt, apron, padsKnown) : null;
    },
    forget(buildings) {
      padsKnown = new WeakMap();
      graded.clear();
      changedSites(buildings);
    },
  };
}
