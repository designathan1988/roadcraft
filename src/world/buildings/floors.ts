import { type GroundAt, type PavedAt, floorHeight } from './foundation';
import type { GroundSince, Rect } from './cameraSolids';
import type { BuildingStore } from './store';
import type { Building } from './types';

/** Nothing is evicted for room: DO NOT cap it. */
export interface BuildingFloors {
  /** The building's ground floor on the ground and the paving as they stand. */
  floorOf(b: Building): number;
  /** Forgets one building's floor (its site worked out again). */
  forget(b: Building): void;
  /** Forgets every floor (the roads or the land moved everywhere). */
  forgetAll(): void;
  /** Forgets the floors whose reach (`boxOf`) a change of the ground since the last `follow` touches; where the diary cannot say, those the regions the caller is shaping (`shaped`) reach, or every one without them. */
  follow(buildings: BuildingStore, ground: GroundSince, shaped?: readonly Rect[] | null): void;
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
    follow(buildings, ground, shaped) {
      if (ground.version === seen) return;
      // DO NOT forget every floor of the town where the diary cannot say: the regions the caller has just shaped hold the change it follows.
      const rects = seen < 0 ? null : ground.rectsSince(seen) ?? shaped ?? null;
      seen = ground.version;
      if (rects === null) { known = new WeakMap(); return; }
      // Every change in one look (`BuildingStore.nearAny`).
      for (const b of buildings.nearAny(rects, reach, (b, r) => {
        const box = boxOf(b);
        return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
      })) known.delete(b);
    },
  };
}
