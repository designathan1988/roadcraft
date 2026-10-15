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
  /** By body class: the lanes' components found so far, and the road ends each reaches (`ReachIndex`). */
  byBody: Map<BodyClass, ReachIndex>;
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
 * Read off the strongly connected components of the lanes (`ReachIndex`),
 * found from the first start that needs them and kept for the revision. DO
 * NOT search the graph from each entry: every entry lane of the map searched
 * the whole town after each edit of the roads.
 */
function reachableExits(w: SimWorld, start: LaneletId, body: BodyClass): readonly LaneletId[] {
  let cache = reachable.get(w);
  if (!cache || cache.revision !== w.net.trafficRevision) {
    cache = { revision: w.net.trafficRevision, byBody: new Map() };
    reachable.set(w, cache);
  }
  let index = cache.byBody.get(body);
  if (!index) cache.byBody.set(body, index = new ReachIndex(w, body));
  const exits = index.exitsFrom(start);
  return exits.includes(start) ? exits.filter((id) => id !== start) : exits;
}

/**
 * The lanes a car of `body` can reach, as the strongly connected components
 * of the link lanes (Tarjan, 1972: an iterative depth-first search, each lane
 * and each way out of it looked at once), with the road ends each component
 * reaches - its own, and those of every component it leads to. Tarjan closes
 * a component only after every one it leads to, so each is summed from
 * components already summed. Searched from a start the first time one of its
 * lanes is asked about: what was found from earlier starts is kept, and the
 * search goes no further into it (the algorithm's own many roots), so the
 * whole graph is searched at most once a revision. The ways out of a lane are
 * the movements this body fits and the lane changes (a car changes lane on
 * the way, `drive/tactical.ts`: what a sibling lane reaches, this one
 * reaches too).
 */
class ReachIndex {
  private readonly componentOf = new Map<LaneletId, number>();
  /** The road ends each component reaches, sorted; shared between components where they reach the same. */
  private readonly exits: (readonly LaneletId[])[] = [];
  private readonly order = new Map<LaneletId, number>();
  private readonly low = new Map<LaneletId, number>();
  private counter = 0;

  constructor(private readonly w: SimWorld, private readonly body: BodyClass) {}

  exitsFrom(start: LaneletId): readonly LaneletId[] {
    const lane = this.w.lanelet(start);
    if (!lane || lane.kind !== 'link') return [];
    if (!this.order.has(start)) this.search(start);
    return this.exits[this.componentOf.get(start)!]!;
  }

  private next(lane: LaneletId): LaneletId[] {
    const out: LaneletId[] = [];
    for (const id of this.w.graph.exitsOf(lane)) {
      const connector = this.w.connector(id);
      if (connector && connector.maxBodyClass >= this.body && connector.toLane && this.w.graph.lanelets.has(connector.toLane)) out.push(connector.toLane);
    }
    for (const sibling of this.w.graph.siblingLanes(lane)) if (this.w.graph.lanelets.has(sibling)) out.push(sibling);
    return out;
  }

  /** Tarjan's search from `root`, over the lanes no earlier search reached. */
  private search(root: LaneletId): void {
    const { order, low, componentOf } = this;
    const stack: LaneletId[] = [];
    const onStack = new Set<LaneletId>();
    const frames: { lane: LaneletId; out: LaneletId[]; at: number }[] = [];
    const open = (lane: LaneletId): void => {
      order.set(lane, this.counter); low.set(lane, this.counter); this.counter++;
      stack.push(lane); onStack.add(lane);
      frames.push({ lane, out: this.next(lane), at: 0 });
    };
    open(root);
    while (frames.length) {
      const f = frames[frames.length - 1]!;
      if (f.at < f.out.length) {
        const to = f.out[f.at++]!;
        if (!order.has(to)) open(to);
        else if (onStack.has(to)) low.set(f.lane, Math.min(low.get(f.lane)!, order.get(to)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.lane, Math.min(low.get(parent.lane)!, low.get(f.lane)!));
      if (low.get(f.lane) !== order.get(f.lane)) continue;
      // A component closed: its lanes off the stack, down to its root.
      const c = this.exits.length;
      const members: LaneletId[] = [];
      while (stack.length) {
        const lane = stack.pop()!;
        onStack.delete(lane);
        componentOf.set(lane, c);
        members.push(lane);
        if (lane === f.lane) break;
      }
      this.exits.push(this.sum(members, c));
    }
  }

  /** A component's road ends: those of its lanes, and those of the components they lead to (closed before it). */
  private sum(members: readonly LaneletId[], c: number): readonly LaneletId[] {
    const own: LaneletId[] = [];
    const beyond = new Set<number>();
    for (const lane of members) {
      if (boundaryExit(this.w, lane)) own.push(lane);
      for (const to of this.next(lane)) {
        const d = this.componentOf.get(to);
        if (d !== undefined && d !== c) beyond.add(d);
      }
    }
    // One component beyond and none of its own: the same list, shared.
    if (!own.length && beyond.size === 1) return this.exits[beyond.values().next().value!]!;
    const all = new Set<LaneletId>(own);
    for (const d of beyond) for (const id of this.exits[d]!) all.add(id);
    return [...all].sort();
  }
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
