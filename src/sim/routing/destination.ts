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

interface ReachableCache {
  revision: number;
  /** By body class: each link lane's component, and the road ends each component reaches (`reachIndex`). */
  byBody: Map<BodyClass, ReachIndex>;
}

interface ReachIndex {
  readonly componentOf: ReadonlyMap<LaneletId, number>;
  /** The road ends each component reaches, sorted; shared between components where they reach the same. */
  readonly exits: readonly (readonly LaneletId[])[];
}

const reachable = new WeakMap<SimWorld, ReachableCache>();

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

function boundaryExit(w: SimWorld, id: LaneletId): boolean {
  const lane = w.lanelet(id);
  return !!lane && lane.kind === 'link' && lane.to !== undefined &&
    w.doc.mapEdge(lane.to) && w.graph.exitsOf(id).length === 0;
}

/**
 * The road ends a vehicle of `body` can reach from `start` (`start` itself
 * left out), sorted: stable per topology revision; traffic cost stays live.
 * Read off the components of the lanes (`reachIndex`), made once per
 * revision and body class. DO NOT search the graph from each entry: every
 * entry lane of the map searched the whole town after each edit of the roads.
 */
function reachableExits(w: SimWorld, start: LaneletId, body: BodyClass): readonly LaneletId[] {
  let cache = reachable.get(w);
  if (!cache || cache.revision !== w.net.trafficRevision) {
    cache = { revision: w.net.trafficRevision, byBody: new Map() };
    reachable.set(w, cache);
  }
  let index = cache.byBody.get(body);
  if (!index) cache.byBody.set(body, index = reachIndex(w, body));
  const c = index.componentOf.get(start);
  if (c === undefined) return [];
  const exits = index.exits[c]!;
  return exits.includes(start) ? exits.filter((id) => id !== start) : exits;
}

/**
 * The lanes a car of `body` can reach from each link lane, as its strongly
 * connected component of the lanes (Tarjan, 1972: one pass over the lanes and
 * the ways between them, an iterative depth-first search) and the road ends
 * each component reaches - its own, and those of every component it leads
 * to. Tarjan's algorithm closes a component only after every one it leads to,
 * so each is summed from components already summed. The ways between lanes
 * are the movements this body fits and the lane changes (a car changes lane
 * on the way, `drive/tactical.ts`: what a sibling lane reaches, this one
 * reaches too).
 * @rebuild Once per topology revision and body class (`reachableExits`).
 */
function reachIndex(w: SimWorld, body: BodyClass): ReachIndex {
  const next = (lane: LaneletId): LaneletId[] => {
    const out: LaneletId[] = [];
    for (const id of w.graph.exitsOf(lane)) {
      const connector = w.connector(id);
      if (connector && connector.maxBodyClass >= body && connector.toLane) out.push(connector.toLane);
    }
    for (const sibling of w.graph.siblingLanes(lane)) out.push(sibling);
    return out;
  };
  const componentOf = new Map<LaneletId, number>();
  const exits: (readonly LaneletId[])[] = [];
  const order = new Map<LaneletId, number>();
  const low = new Map<LaneletId, number>();
  const onStack = new Set<LaneletId>();
  const stack: LaneletId[] = [];
  let counter = 0;
  for (const root of w.graph.lanelets.values()) {
    if (root.kind !== 'link' || order.has(root.id)) continue;
    const frames: { lane: LaneletId; out: LaneletId[]; at: number }[] = [];
    const open = (lane: LaneletId): void => {
      order.set(lane, counter); low.set(lane, counter); counter++;
      stack.push(lane); onStack.add(lane);
      frames.push({ lane, out: next(lane), at: 0 });
    };
    open(root.id);
    while (frames.length) {
      const f = frames[frames.length - 1]!;
      if (f.at < f.out.length) {
        const to = f.out[f.at++]!;
        if (!w.graph.lanelets.has(to)) continue;
        if (!order.has(to)) { open(to); continue; }
        if (onStack.has(to)) low.set(f.lane, Math.min(low.get(f.lane)!, order.get(to)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.lane, Math.min(low.get(parent.lane)!, low.get(f.lane)!));
      if (low.get(f.lane) !== order.get(f.lane)) continue;
      // A component closed: its lanes, its own road ends, and those of the
      // components its lanes lead to (closed already, each with its id).
      const c = exits.length;
      const members: LaneletId[] = [];
      for (;;) {
        const lane = stack.pop()!;
        onStack.delete(lane);
        componentOf.set(lane, c);
        members.push(lane);
        if (lane === f.lane) break;
      }
      const own: LaneletId[] = [];
      const beyond = new Set<number>();
      for (const lane of members) {
        if (boundaryExit(w, lane)) own.push(lane);
        for (const to of next(lane)) {
          const d = componentOf.get(to);
          if (d !== undefined && d !== c) beyond.add(d);
        }
      }
      // One component beyond and none of its own: the same list, shared.
      if (!own.length && beyond.size === 1) { exits.push(exits[beyond.values().next().value!]!); continue; }
      const all = new Set<LaneletId>(own);
      for (const d of beyond) for (const id of exits[d]!) all.add(id);
      exits.push([...all].sort());
    }
  }
  return { componentOf, exits };
}

/** Chooses one reachable trip endpoint, once, when a vehicle enters the city. */
export function chooseVehicleDestination(w: SimWorld, start: LaneletId, body: BodyClass): LaneletId | null {
  const exits = reachableExits(w, start, body);
  if (exits.length === 0) return null;
  return exits[Math.floor(w.rng.route.float() * exits.length)] ?? exits[0] ?? null;
}

/**
 * Least-time lanelet route to a fixed endpoint, with congestion priced at
 * planning time. A*, by the same lower bound as the trip planner
 * (`drive/tactical.ts` planTrip, `tripLowerBound`): the same least-time
 * route, without searching the whole town on the way to a far road end.
 */
export function routeToDestination(w: SimWorld, start: LaneletId, goal: LaneletId, body: BodyClass): LaneletId[] | null {
  if (start === goal) return [start];
  if (!w.lanelet(start) || !w.lanelet(goal) || w.rt(goal).ghost) return null;
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
