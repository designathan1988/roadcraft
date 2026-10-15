import type { Lanelet, LaneletId } from '@world/lanelets';
import { ROAD_SECTION_LIMITS } from '@world/roadSection';
import { kmh } from '@world/units';

/**
 * A LOWER BOUND OF A TRIP'S COST, for the route searches (`drive/tactical.ts`
 * planTrip, `routing/destination.ts` routeToDestination), which price a step
 * as the seconds to drive it: a connector's length at 0.65 of the limit of the
 * lane it leads to, a lane's length at its limit (and more for its traffic),
 * a turn, a lane change - never less than its length at the fastest limit a
 * road may have. The way from the end of a lane to the end of the goal runs
 * from one to the other, so it is no shorter than the straight line between
 * them; nor is it quicker than that line at that limit. That is the bound:
 * admissible, so A* finds the cheapest trip (amitp, "Heuristics": h never
 * above the true cost, "A* is guaranteed to find a shortest path"). A lane
 * change moves the end by a lane or two, a fraction of a second at that
 * limit, where it costs seconds.
 *
 * The fastest limit is the document's ceiling on a road's speed
 * (`ROAD_SECTION_LIMITS.speedKmh`, clamped at the document's boundary,
 * `normalizeRoadSection`; the road types' own limits are under it): a bound
 * that needs no pass over the lanes of the map. DO NOT work out the fastest
 * lane of the graph here: every lane of the town again at each edit, for a
 * bound that is a constant of the document.
 */
const FASTEST_LIMIT = kmh(ROAD_SECTION_LIMITS.speedKmh[1]);

/**
 * What the bound reads of the world (`SimWorld.lanelet`). DO NOT import
 * `SimWorld`: the world reaches this file, and the type import closed an
 * import cycle (`tests/arch/imports.spec.ts`).
 */
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
