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
      const lane = w.lanelet(id);
      if (!lane) h = 0;
      else {
        const p = lane.centre.point(lane.centre.n - 1);
        h = Math.hypot(end.x - p.x, end.y - p.y) / FASTEST_LIMIT;
      }
      known.set(id, h);
    }
    return h;
  };
}
