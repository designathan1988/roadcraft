import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/**
 * A LOWER BOUND OF A TRIP'S COST, for the route searches (`drive/tactical.ts`
 * planTrip, `routing/destination.ts` routeToDestination), which price a step
 * as the seconds to drive it: a connector's length at 0.65 of the limit of the
 * lane it leads to, a lane's length at its limit (and more for its traffic),
 * a turn, a lane change - never less than its length over the fastest limit
 * of the town. The way from the end of a lane to the end of the goal runs
 * from one to the other, so it is no shorter than the straight line between
 * them; nor is it quicker than that line at the fastest limit. That is the
 * bound: admissible, so A* finds the cheapest trip (amitp, "Heuristics":
 * h never above the true cost, "A* is guaranteed to find a shortest path").
 * A lane change moves the end by a lane or two, a fraction of a second at
 * any limit, where it costs seconds.
 */

/** Every lane's limit, the fastest: worked out once per build of the graph. */
const FASTEST = new WeakMap<object, { readonly revision: number; readonly speed: number }>();

/** @rebuild The fastest lane's limit, read once per build of the lanelet graph (`trapLanes` is kept the same way). */
function fastestLimit(w: SimWorld): number {
  const known = FASTEST.get(w.graph);
  if (known && known.revision === w.graph.revision) return known.speed;
  // As slow as the slowest a step is ever priced at (`m(0.2)`), at least.
  let speed = m(0.2);
  for (const lane of w.graph.lanelets.values()) if (lane.speedLimit > speed) speed = lane.speedLimit;
  FASTEST.set(w.graph, { revision: w.graph.revision, speed });
  return speed;
}

/** The bound to `goal` from the end of a lane, seconds, each lane's worked out once a search. */
export function tripLowerBound(w: SimWorld, goal: LaneletId): (lane: LaneletId) => number {
  const target = w.lanelet(goal);
  if (!target) return () => 0;
  const end = target.centre.point(target.centre.n - 1);
  const speed = fastestLimit(w);
  const known = new Map<LaneletId, number>();
  return (id) => {
    let h = known.get(id);
    if (h === undefined) {
      const lane = w.lanelet(id);
      if (!lane) h = 0;
      else {
        const p = lane.centre.point(lane.centre.n - 1);
        h = Math.hypot(end.x - p.x, end.y - p.y) / speed;
      }
      known.set(id, h);
    }
    return h;
  };
}
