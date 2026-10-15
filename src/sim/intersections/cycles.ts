import type { GraphChange, LaneletGraph, LaneletId } from '@world/lanelets';
import type { NodeId } from '@world/ids';
import type { ChangeLog } from '@core/changeLog';
import { JAM_GAP } from '../params';
import type { SimWorld } from '../world';
import { m } from '@world/units';

/** Small closed loops of road: rings of streets, roundabouts drawn as polygons. */

/** A small closed loop of road: its lanelets and the queue it can hold. */
export interface RoadCycle {
  readonly id: number;
  /** Road a queue can stand on: the summed length of the loop's links. */
  readonly storage: number;
  readonly lanelets: ReadonlySet<LaneletId>;
}

/** Loops with more storage than this are a street network, not a ring. */
const MAX_CYCLE_STORAGE = m(560);
/** Share of a loop's storage past which nobody more is let on. */
const METER_SHARE = 0.7;

const indexes = new WeakMap<LaneletGraph, CycleIndex>();

function indexOf(w: SimWorld): CycleIndex {
  let index = indexes.get(w.graph);
  if (!index) indexes.set(w.graph, index = new CycleIndex());
  index.follow(w.graph, w.topologyLog);
  return index;
}

/** The small loops a lanelet belongs to, kept by what each edit changed (`CycleIndex`). */
export function cyclesOf(w: SimWorld, lanelet: LaneletId): readonly RoadCycle[] {
  return indexOf(w).byLanelet.get(lanelet) ?? [];
}

/** DO NOT go back to walking `w.vehicles` here: that was the whole fleet for every request onto a ring, every tick. */
export function cycleFull(w: SimWorld, from: LaneletId, to: LaneletId, need: number): boolean {
  for (const cycle of cyclesOf(w, to)) {
    if (cycle.lanelets.has(from)) continue;
    let used = need;
    for (const lane of cycle.lanelets) {
      for (const id of w.rt(lane).order) {
        const v = w.veh(id);
        if (!v) continue;
        used += v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
      }
    }
    if (used > cycle.storage * METER_SHARE) return true;
  }
  return false;
}

/** DO NOT search every link of the map again for an edit: every road drawn did the town's searches again. */
export class CycleIndex {
  readonly byLanelet = new Map<LaneletId, RoadCycle[]>();
  /** Each link searched: the loop it found (its key), and what the search read. */
  private readonly ofStart = new Map<LaneletId, { readonly key: string | null; readonly lanes: readonly LaneletId[]; readonly nodes: readonly NodeId[] }>();
  /** The links whose search read each lanelet, and each junction. */
  private readonly laneReaders = new Map<LaneletId, Set<LaneletId>>();
  private readonly nodeReaders = new Map<NodeId, Set<LaneletId>>();
  /** Each loop found, by its links, and how many searches found it. */
  private readonly loops = new Map<string, { readonly cycle: RoadCycle; finders: number }>();
  private nextId = 0;
  private seen: object | null = null;

  /** Brought up to the lane graph's changes since it was last. */
  follow(graph: LaneletGraph, log: ChangeLog<GraphChange>): void {
    const changes = log.since(this.seen);
    if (changes !== null && !changes.length) return;
    this.seen = log.state;
    const starts = changes === null ? this.restart(graph) : new Set<LaneletId>();
    if (changes !== null) {
      for (const change of changes) {
        for (const lane of change.lanelets) {
          starts.add(lane);
          for (const start of this.laneReaders.get(lane) ?? []) starts.add(start);
        }
        for (const node of change.junctions) for (const start of this.nodeReaders.get(node) ?? []) starts.add(start);
      }
      for (const start of starts) this.forget(start);
    }
    for (const start of [...starts].sort()) if (graph.lanelets.get(start)?.kind === 'link') this.search(graph, start);
  }

  /** @rebuild Everything forgotten, and every link to search. */
  private restart(graph: LaneletGraph): Set<LaneletId> {
    this.byLanelet.clear();
    this.ofStart.clear();
    this.laneReaders.clear();
    this.nodeReaders.clear();
    this.loops.clear();
    const starts = new Set<LaneletId>();
    for (const lane of graph.lanelets.values()) if (lane.kind === 'link') starts.add(lane.id);
    return starts;
  }

  /** A link's search taken away: its reads, and its share of the loop it found. */
  private forget(start: LaneletId): void {
    const made = this.ofStart.get(start);
    if (!made) return;
    this.ofStart.delete(start);
    for (const lane of made.lanes) unfile(this.laneReaders, lane, start);
    for (const node of made.nodes) unfile(this.nodeReaders, node, start);
    if (made.key === null) return;
    const loop = this.loops.get(made.key)!;
    if (--loop.finders > 0) return;
    this.loops.delete(made.key);
    for (const id of loop.cycle.lanelets) {
      const list = this.byLanelet.get(id);
      if (!list) continue;
      const i = list.indexOf(loop.cycle);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.byLanelet.delete(id);
    }
  }

  /** One link's shortest way back to itself, and what it read on the way. */
  private search(graph: LaneletGraph, start: LaneletId): void {
    const lanes = new Set<LaneletId>([start]);
    const nodes = new Set<NodeId>();
    const length = (id: LaneletId): number => {
      lanes.add(id);
      const lane = graph.lanelets.get(id);
      return lane?.kind === 'link' ? lane.length : 0;
    };
    /** Links reachable from a link through one connector that is not a U-turn. */
    const next = (id: LaneletId): LaneletId[] => {
      lanes.add(id);
      const to = graph.lanelets.get(id)?.to;
      if (to !== undefined) nodes.add(to);
      const out: LaneletId[] = [];
      for (const c of graph.exitsOf(id)) {
        lanes.add(c);
        const connector = graph.lanelets.get(c) as { kind: string; turn?: string; toLane?: LaneletId } | undefined;
        if (!connector || connector.turn === 'uturn' || !connector.toLane) continue;
        out.push(connector.toLane);
      }
      return out.sort();
    };

    // Dijkstra over links from the start's exits back to the start.
    const best = new Map<LaneletId, number>();
    const parent = new Map<LaneletId, LaneletId>();
    const open = new OpenSet();
    for (const n of next(start)) {
      const cost = length(start) + length(n);
      if (n === start) continue;
      if (cost <= MAX_CYCLE_STORAGE && cost < (best.get(n) ?? Infinity)) {
        best.set(n, cost);
        parent.set(n, start);
        open.push({ id: n, cost });
      }
    }
    let closing: LaneletId | null = null;
    let closingCost = Infinity;
    while (open.size) {
      const { id, cost } = open.pop();
      if (cost > (best.get(id) ?? Infinity) || cost >= closingCost) continue;
      for (const n of next(id)) {
        if (n === start) {
          if (cost < closingCost) {
            closingCost = cost;
            closing = id;
          }
          continue;
        }
        const c = cost + length(n);
        if (c > MAX_CYCLE_STORAGE || c >= (best.get(n) ?? Infinity)) continue;
        best.set(n, c);
        parent.set(n, id);
        open.push({ id: n, cost: c });
      }
    }
    let key: string | null = null;
    if (closing !== null) {
      const loop: LaneletId[] = [start];
      for (let at: LaneletId | undefined = closing; at !== undefined && at !== start; at = parent.get(at)) loop.push(at);
      key = [...loop].sort().join('|');
      const known = this.loops.get(key);
      if (known) known.finders++;
      else {
        // The connectors between the loop's links belong to it too: a car in the box between two of them is on the loop.
        const members = new Set<LaneletId>(loop);
        for (const link of loop) {
          for (const c of graph.exitsOf(link)) {
            const connector = graph.lanelets.get(c) as { toLane?: LaneletId } | undefined;
            if (connector?.toLane && members.has(connector.toLane)) members.add(c);
          }
        }
        const cycle: RoadCycle = { id: this.nextId++, storage: closingCost, lanelets: members };
        this.loops.set(key, { cycle, finders: 1 });
        for (const id of members) {
          const list = this.byLanelet.get(id);
          if (list) list.push(cycle); else this.byLanelet.set(id, [cycle]);
        }
      }
    }
    this.ofStart.set(start, { key, lanes: [...lanes], nodes: [...nodes] });
    for (const lane of lanes) file(this.laneReaders, lane, start);
    for (const node of nodes) file(this.nodeReaders, node, start);
  }
}

function file<K>(lists: Map<K, Set<LaneletId>>, key: K, start: LaneletId): void {
  const set = lists.get(key);
  if (set) set.add(start); else lists.set(key, new Set([start]));
}

function unfile<K>(lists: Map<K, Set<LaneletId>>, key: K, start: LaneletId): void {
  const set = lists.get(key);
  if (!set) return;
  set.delete(start);
  if (!set.size) lists.delete(key);
}

/** DO NOT go back to sorting the open list for every pop. */
class OpenSet {
  private readonly items: { id: LaneletId; cost: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: { id: LaneletId; cost: number }): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(items[i]!, items[p]!)) break;
      const t = items[i]!; items[i] = items[p]!; items[p] = t;
      i = p;
    }
  }

  pop(): { id: LaneletId; cost: number } {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && before(items[l]!, items[m]!)) m = l;
        if (r < items.length && before(items[r]!, items[m]!)) m = r;
        if (m === i) break;
        const t = items[i]!; items[i] = items[m]!; items[m] = t;
        i = m;
      }
    }
    return top;
  }
}

/** Cheaper first, then the lower id. */
const before = (a: { id: LaneletId; cost: number }, b: { id: LaneletId; cost: number }): boolean =>
  a.cost < b.cost || (a.cost === b.cost && a.id < b.id);
