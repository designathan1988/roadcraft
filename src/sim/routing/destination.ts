import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import type { SimWorld } from '../world';
import { m } from '@world/units';
import { tripLowerBound } from './lowerBound';

interface RouteStep {
  readonly lane: LaneletId;
  readonly cost: number;
  /** `cost` and a lower bound of what is left (`tripLowerBound`): the order the search takes steps in. */
  readonly f: number;
}

interface Parent {
  readonly lane: LaneletId;
  readonly connector: LaneletId;
}

const compare = (a: RouteStep, b: RouteStep): number =>
  a.f - b.f || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);

function push(heap: RouteStep[], value: RouteStep): void {
  let at = heap.length;
  heap.push(value);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (compare(heap[parent]!, value) <= 0) break;
    heap[at] = heap[parent]!;
    at = parent;
  }
  heap[at] = value;
}

function pop(heap: RouteStep[]): RouteStep | undefined {
  const first = heap[0];
  const tail = heap.pop();
  if (!first || !tail || heap.length === 0) return first;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) < 0) child++;
    if (compare(tail, heap[child]!) <= 0) break;
    heap[at] = heap[child]!;
    at = child;
  }
  heap[at] = tail;
  return first;
}

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
  const best = new Map<LaneletId, number>([[start, 0]]);
  const parent = new Map<LaneletId, Parent>();
  const heap: RouteStep[] = [];
  const toGo = tripLowerBound(w, goal);
  push(heap, { lane: start, cost: 0, f: toGo(start) });

  while (heap.length) {
    const current = pop(heap)!;
    if (current.cost > (best.get(current.lane) ?? Infinity) + 1e-9) continue;
    if (current.lane === goal) {
      const route: LaneletId[] = [goal];
      let lane = goal;
      while (lane !== start) {
        const step = parent.get(lane);
        if (!step) return null;
        route.unshift(step.lane, step.connector);
        lane = step.lane;
      }
      return route;
    }
    for (const id of w.graph.exitsOf(current.lane)) {
      const connector = w.connector(id);
      const out = connector && w.lanelet(connector.toLane);
      if (!connector || connector.maxBodyClass < body || !out || out.kind !== 'link' || w.rt(out.id).ghost) continue;
      const density = w.rt(out.id).order.length / Math.max(1, out.length / m(4.8));
      const travel = out.length / Math.max(m(0.2), out.speedLimit) * (1 + density * 2.6);
      const turn = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
      const cost = current.cost + connector.length / Math.max(m(0.2), out.speedLimit * 0.65) + travel + turn;
      if (cost >= (best.get(out.id) ?? Infinity) - 1e-9) continue;
      best.set(out.id, cost);
      parent.set(out.id, { lane: current.lane, connector: id });
      push(heap, { lane: out.id, cost, f: cost + toGo(out.id) });
    }
  }
  return null;
}
