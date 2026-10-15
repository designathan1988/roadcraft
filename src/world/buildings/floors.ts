import { type GroundAt, type PavedAt, floorHeight } from './foundation';
import type { GroundSince, Rect } from './cameraSolids';
import type { BuildingStore } from './store';
import type { Building } from './types';

/**
 * EACH BUILDING'S GROUND FLOOR, WORKED OUT ONCE (`foundation.ts` `floorHeight`)
 * for every reader: the platform its site is graded to (`siteGrading.ts`,
 * `pads.ts` `padOf`) and the camera's solids (`cameraSolids.ts`) asked it of
 * the same records again and again - 5.3 s and 1.75 s of the page in the growth
 * of a 2,560 m city (profiled 2026-10-15). A floor is a pure function of its
 * record (records are replaced, never changed in place) and of the ground and
 * paving it reads within `FLOOR_READ_REACH` of its bounds, so it is kept by
 * record (an identity memo, Bazel's action cache keyed by its inputs) and
 * forgotten by place: a change of what it reads - the diary's ground and roads'
 * heights (`follow`) - forgets the floors whose reach it touches; a building
 * worked out again for the roads (`forget`) or the whole map read again
 * (`forgetAll`) forgets its own. Nothing is evicted for room: DO NOT cap it.
 */
export interface BuildingFloors {
  /** The building's ground floor on the ground and the paving as they stand. */
  floorOf(b: Building): number;
  /** Forgets one building's floor (its site worked out again). */
  forget(b: Building): void;
  /** Forgets every floor (the roads or the land moved everywhere). */
  forgetAll(): void;
  /** Forgets the floors whose reach (`boxOf`) a change of the ground since the last `follow` touches. */
  follow(buildings: BuildingStore, ground: GroundSince): void;
}

/** `boxOf`: a building's bounds grown by how far its floor reads (`FLOOR_READ_REACH`), `reach` that growth. */
export function buildingFloors(groundAt: GroundAt, pavedAt: PavedAt | undefined, boxOf: (b: Building) => Rect, reach: number): BuildingFloors {
  let known = new WeakMap<Building, number>();
  let seen = -1;
  return {
    floorOf(b) {
      let floor = known.get(b);
      if (floor === undefined) known.set(b, floor = floorHeight(b, groundAt, pavedAt));
      return floor;
    },
    forget(b) {
      known.delete(b);
    },
    forgetAll() {
      known = new WeakMap();
    },
    follow(buildings, ground) {
      if (ground.version === seen) return;
      const rects = seen < 0 ? null : ground.rectsSince(seen);
      seen = ground.version;
      if (rects === null) { known = new WeakMap(); return; }
      for (const r of rects) {
        for (const b of buildings.near(r[0] - reach, r[1] - reach, r[2] + reach, r[3] + reach)) {
          const box = boxOf(b);
          if (box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1]) known.delete(b);
        }
      }
    },
  };
}
