import type { Lanelet, LaneletId } from '@world/lanelets';
import { ROAD_SECTION_LIMITS } from '@world/roadSection';
import { kmh } from '@world/units';

/** DO NOT work out the fastest lane of the graph here */
const FASTEST_LIMIT = kmh(ROAD_SECTION_LIMITS.speedKmh[1]);

/** DO NOT import `SimWorld`: the world reaches this file, and the type import closed an import cycle */
export interface LaneLookup {
  lanelet(id: LaneletId): Lanelet | undefined;
}

/** The bound to `goal` from the end of a lane, seconds, each lane's worked out once a search. */
export function tripLowerBound(w: LaneLookup, goal: LaneletId): (lane: LaneletId) => number {
  const target = w.lanelet(goal);
  if (!target) return () => 0;
  const end = target.centre.point(target.centre.n - 1);
  const known = new Map<LaneletId, number>();
  return (id) => {
    let h = known.get(id);
    if (h === undefined) {
      h = laneLowerBound(w, id, end);
      known.set(id, h);
    }
    return h;
  };
}

/** The end of the goal lane, for `laneLowerBound`; null when there is no goal lane. */
export function goalEnd(w: LaneLookup, goal: LaneletId): { readonly x: number; readonly y: number } | null {
  const target = w.lanelet(goal);
  return target ? target.centre.point(target.centre.n - 1) : null;
}

/** The bound to the goal ending at `end` from the end of lane `id`, seconds (`tripLowerBound` works each out once a search). */
export function laneLowerBound(w: LaneLookup, id: LaneletId, end: { readonly x: number; readonly y: number }): number {
  const lane = w.lanelet(id);
  if (!lane) return 0;
  const p = lane.centre.point(lane.centre.n - 1);
  return Math.hypot(end.x - p.x, end.y - p.y) / FASTEST_LIMIT;
}
