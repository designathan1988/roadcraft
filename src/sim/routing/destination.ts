import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import type { SimWorld } from '../world';
import { m } from '@world/units';
import { goalEnd, laneLowerBound } from './lowerBound';
import { noteCapped, noteSearch, searchScratch } from './searchScratch';

/** DO NOT search the graph from each entry */
function reachableExits(w: SimWorld, start: LaneletId, body: BodyClass): readonly LaneletId[] {
  const exits = w.laneReaches.exitsFrom(w, start, body);
  return exits.includes(start) ? exits.filter((id) => id !== start) : exits;
}

/** Chooses one reachable trip endpoint, once, when a vehicle enters the city. */
export function chooseVehicleDestination(w: SimWorld, start: LaneletId, body: BodyClass): LaneletId | null {
  const exits = reachableExits(w, start, body);
  if (exits.length === 0) return null;
  return exits[Math.floor(w.rng.route.float() * exits.length)] ?? exits[0] ?? null;
}

/** Least-time lanelet route to a fixed endpoint, with congestion priced at planning time. */
export function routeToDestination(w: SimWorld, start: LaneletId, goal: LaneletId, body: BodyClass): LaneletId[] | null {
  if (start === goal) return [start];
  if (!w.lanelet(start) || !w.lanelet(goal) || w.rt(goal).ghost) return null;
  // DO NOT expand the whole graph to find out a goal cannot be reached: the lanes' components say so first (`laneReach.ts`).
  if (!w.laneReaches.mayReach(w, start, goal, body)) return null;
  const scratch = searchScratch(w);
  scratch.begin(w.graph.lanelets.size + w.graph.connectors.size);
  const cap = noteSearch(w);
  const end = goalEnd(w, goal)!;
  const toGo = (slot: number): number => {
    let h = scratch.boundOf(slot);
    if (h === undefined) scratch.setBound(slot, h = laneLowerBound(w, scratch.ids[slot]!, end));
    return h;
  };
  // One state per lane, as the string search kept: the even states of the scratch.
  const startSlot = scratch.slot(start);
  const startState = startSlot * 2;
  scratch.setBest(startState, 0, -1, -1);
  scratch.push(startState, 0, toGo(startSlot));

  let expanded = 0;
  while (scratch.size) {
    const state = scratch.pop();
    const currentCost = scratch.poppedCost;
    if (currentCost > scratch.best(state) + 1e-9) continue;
    // DO NOT walk the whole map for one car: past the cap there is no route (the car drives on by its lookahead).
    if (++expanded > cap) { noteCapped(w); return null; }
    const currentLane = scratch.ids[state >> 1]!;
    if (currentLane === goal) {
      // DO NOT `unshift`: the route is gathered goal first and turned round once.
      const route: LaneletId[] = [goal];
      for (let at = state; at !== startState;) {
        if (scratch.best(at) === Infinity) return null;
        const from = scratch.parent[at]!;
        route.push(scratch.ids[scratch.via[at]!]!, scratch.ids[from >> 1]!);
        at = from;
      }
      return route.reverse();
    }
    for (const id of w.graph.exitsOf(currentLane)) {
      const connector = w.connector(id);
      const out = connector && w.lanelet(connector.toLane);
      if (!connector || connector.maxBodyClass < body || !out || out.kind !== 'link' || w.rt(out.id).ghost) continue;
      const density = w.rt(out.id).order.length / Math.max(1, out.length / m(4.8));
      const travel = out.length / Math.max(m(0.2), out.speedLimit) * (1 + density * 2.6);
      const turn = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
      const cost = currentCost + connector.length / Math.max(m(0.2), out.speedLimit * 0.65) + travel + turn;
      const outSlot = scratch.slot(out.id);
      if (cost >= scratch.best(outSlot * 2) - 1e-9) continue;
      scratch.setBest(outSlot * 2, cost, state, scratch.slot(id));
      scratch.push(outSlot * 2, cost, cost + toGo(outSlot));
    }
  }
  return null;
}
