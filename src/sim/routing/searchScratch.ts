import type { LaneletId } from '@world/lanelets';

/**
 * The working memory of the trip searches (`planTrip`, `routeToDestination`), one per world and kept between searches (SIM-01):
 * every lane and movement a search meets gets a dense slot, and the costs, parents and bounds of a search live in typed arrays
 * under a generation stamp, so a search allocates nothing. A search's state is `slot * 2 + changed`.
 * DO NOT change the order the heap gives states in: equal `f` falls back to the key the string search compared
 * (`lane`, or `lane|c` for a state reached by a lane change), and the routes the drivers take depend on it.
 */
export class SearchScratch {
  private readonly slots = new Map<LaneletId, number>();
  /** The id of each slot. */
  readonly ids: LaneletId[] = [];
  private generation = 0;
  private stamp = new Uint32Array(0);
  /** Least cost found to each state, this search. */
  private bestCost = new Float64Array(0);
  /** The state each was reached from, and the movement's slot (-1: a lane change). */
  parent = new Int32Array(0);
  via = new Int32Array(0);
  /** The bound to the goal from each slot, this search (`tripLowerBound`). */
  private boundStamp = new Uint32Array(0);
  private bound = new Float64Array(0);

  private heapState = new Int32Array(64);
  private heapCost = new Float64Array(64);
  private heapF = new Float64Array(64);
  size = 0;
  /** The state whose key is its lane but that may not change lanes (the start of a search that may not begin with one). */
  private plainNoChange = -1;

  /** A new search: every cost back to unknown, the heap empty; `liveIds` bounds the slots kept for lanes long gone. */
  begin(liveIds: number): void {
    if (this.ids.length > 2 * liveIds + 1024) {
      this.slots.clear();
      this.ids.length = 0;
      this.generation = 0;
      this.stamp.fill(0);
      this.boundStamp.fill(0);
    }
    if (++this.generation === 0xffffffff) {
      this.generation = 1;
      this.stamp.fill(0);
      this.boundStamp.fill(0);
    }
    this.size = 0;
    this.plainNoChange = -1;
  }

  slot(id: LaneletId): number {
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = this.ids.length;
      this.ids.push(id);
      this.slots.set(id, slot);
      if (slot >= this.bound.length) this.grow(slot + 1);
    }
    return slot;
  }

  private grow(slots: number): void {
    const n = Math.max(slots, this.bound.length * 2, 256);
    const more = <T extends Uint32Array | Float64Array | Int32Array>(a: T, size: number): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a);
      return b;
    };
    this.stamp = more(this.stamp, n * 2);
    this.bestCost = more(this.bestCost, n * 2);
    this.parent = more(this.parent, n * 2);
    this.via = more(this.via, n * 2);
    this.boundStamp = more(this.boundStamp, n);
    this.bound = more(this.bound, n);
  }

  best(state: number): number {
    return this.stamp[state] === this.generation ? this.bestCost[state]! : Infinity;
  }

  setBest(state: number, cost: number, from: number, via: number): void {
    this.stamp[state] = this.generation;
    this.bestCost[state] = cost;
    this.parent[state] = from;
    this.via[state] = via;
  }

  /** The bound from `slot`, or undefined when this search has not worked it out yet. */
  boundOf(slot: number): number | undefined {
    return this.boundStamp[slot] === this.generation ? this.bound[slot] : undefined;
  }

  setBound(slot: number, value: number): void {
    this.boundStamp[slot] = this.generation;
    this.bound[slot] = value;
  }

  /** Marks the one state whose key is its lane's id although it may not change lanes. */
  markPlainNoChange(state: number): void {
    this.plainNoChange = state;
  }

  /** Whether the state was reached by a lane change, or may not make one: what the string search's node held as `changed`. */
  changed(state: number): boolean {
    return (state & 1) === 1 || state === this.plainNoChange;
  }

  // The heap of the string searches, entry for entry: the same sifts, the same comparison.

  private compare(fa: number, a: number, fb: number, b: number): number {
    return fa - fb || this.compareKeys(a, b);
  }

  private compareKeys(a: number, b: number): number {
    const x = this.ids[a >> 1]!, y = this.ids[b >> 1]!;
    const xc = (a & 1) === 1, yc = (b & 1) === 1;
    if (!xc && !yc) return x < y ? -1 : x > y ? 1 : 0;
    // As `${lane}|c` compares, without making the string.
    const lx = x.length + (xc ? 2 : 0), ly = y.length + (yc ? 2 : 0);
    const n = Math.min(lx, ly);
    for (let i = 0; i < n; i++) {
      const p = i < x.length ? x.charCodeAt(i) : i === x.length ? 124 : 99;
      const q = i < y.length ? y.charCodeAt(i) : i === y.length ? 124 : 99;
      if (p !== q) return p < q ? -1 : 1;
    }
    return lx < ly ? -1 : lx > ly ? 1 : 0;
  }

  push(state: number, cost: number, f: number): void {
    if (this.size === this.heapState.length) {
      const n = this.size * 2;
      const s = new Int32Array(n); s.set(this.heapState); this.heapState = s;
      const c = new Float64Array(n); c.set(this.heapCost); this.heapCost = c;
      const g = new Float64Array(n); g.set(this.heapF); this.heapF = g;
    }
    let at = this.size++;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.compare(this.heapF[parent]!, this.heapState[parent]!, f, state) <= 0) break;
      this.move(parent, at);
      at = parent;
    }
    this.heapState[at] = state;
    this.heapCost[at] = cost;
    this.heapF[at] = f;
  }

  /** The first state; its cost is `poppedCost`. Call only with `size > 0`. */
  poppedCost = 0;
  pop(): number {
    const first = this.heapState[0]!;
    this.poppedCost = this.heapCost[0]!;
    const last = --this.size;
    if (last === 0) return first;
    const state = this.heapState[last]!, cost = this.heapCost[last]!, f = this.heapF[last]!;
    let at = 0;
    while (at * 2 + 1 < last) {
      let child = at * 2 + 1;
      if (child + 1 < last && this.compare(this.heapF[child + 1]!, this.heapState[child + 1]!, this.heapF[child]!, this.heapState[child]!) < 0) child++;
      if (this.compare(f, state, this.heapF[child]!, this.heapState[child]!) <= 0) break;
      this.move(child, at);
      at = child;
    }
    this.heapState[at] = state;
    this.heapCost[at] = cost;
    this.heapF[at] = f;
    return first;
  }

  private move(from: number, to: number): void {
    this.heapState[to] = this.heapState[from]!;
    this.heapCost[to] = this.heapCost[from]!;
    this.heapF[to] = this.heapF[from]!;
  }
}

const scratches = new WeakMap<object, SearchScratch>();
/** The world's search memory. */
export function searchScratch(w: object): SearchScratch {
  let s = scratches.get(w);
  if (!s) scratches.set(w, s = new SearchScratch());
  return s;
}
