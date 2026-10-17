import type { ChangeLog } from '@core/changeLog';
import type { BodyClass } from '@world/conflictPoints';
import type { RoadDoc } from '@world/doc';
import type { Connector, GraphChange, Lanelet, LaneletGraph, LaneletId } from '@world/lanelets';

/** DO NOT import `SimWorld`: `sim/world.ts` imports this file, and the type import closed an import cycle */
export interface ReachWorld {
  readonly doc: RoadDoc;
  readonly graph: LaneletGraph;
  readonly topologyLog: ChangeLog<GraphChange>;
  lanelet(id: LaneletId): Lanelet | undefined;
  connector(id: string): Connector | undefined;
}

/** DO NOT search every lane of the map again for an edit of the roads */
class BodyReach {
  private readonly comp = new Map<LaneletId, number>();
  private readonly members = new Map<number, Set<LaneletId>>();
  /** Each link's ways out (with repeats, as `next` lists them), and the ways in to each, counted. */
  private readonly out = new Map<LaneletId, LaneletId[]>();
  private readonly into = new Map<LaneletId, Map<LaneletId, number>>();
  /** The condensation: ways out between two components, counted, each way. */
  private readonly condOut = new Map<number, Map<number, number>>();
  private readonly condIn = new Map<number, Map<number, number>>();
  /** Each component's road ends, sorted, summed when asked (`exitsOf`). */
  private readonly exitsMemo = new Map<number, readonly LaneletId[]>();
  private nextComp = 0;
  /** Lanes looked at since made (the scale tests' count). */
  work = 0;

  constructor(private readonly body: BodyClass) {}

  /** The road ends reachable from a link lane (its own included when it is one). */
  exitsFrom(w: ReachWorld, start: LaneletId): readonly LaneletId[] {
    const c = this.comp.get(start);
    return c === undefined ? [] : this.exitsOf(w, c);
  }

  /** Each component asked from, with the components it leads to (itself included): forgotten at any change of the graph. */
  private readonly ahead = new Map<number, ReadonlySet<number>>();

  /** Whether a link lane can lead to another for this body; null when one of them is no link lane known here. */
  reachesFrom(start: LaneletId, goal: LaneletId): boolean | null {
    const cu = this.comp.get(start), cv = this.comp.get(goal);
    if (cu === undefined || cv === undefined) return null;
    if (cu === cv) return true;
    let ahead = this.ahead.get(cu);
    if (!ahead) this.ahead.set(cu, ahead = this.walkCond(cu, this.condOut, null));
    return ahead.has(cv);
  }

  /** @rebuild Every link lane: a body class asked for the first time, or a lane graph built whole. */
  buildAll(w: ReachWorld): void {
    this.ahead.clear();
    this.comp.clear(); this.members.clear(); this.out.clear(); this.into.clear();
    this.condOut.clear(); this.condIn.clear(); this.exitsMemo.clear();
    const links: LaneletId[] = [];
    for (const lane of w.graph.lanelets.values()) if (lane.kind === 'link') links.push(lane.id);
    for (const id of links) { this.work++; this.out.set(id, this.next(w, id)); }
    for (const id of links) for (const v of this.out.get(id)!) this.countIn(v, id, 1);
    for (const list of this.tarjan(links, () => true)) this.label(list);
    for (const id of links) for (const v of this.out.get(id)!) this.cond(this.comp.get(id)!, this.comp.get(v)!, 1);
  }

  /** Brought up to the lane graph's changes. */
  follow(w: ReachWorld, changes: readonly GraphChange[]): void {
    this.ahead.clear();
    const isLink = (id: LaneletId): boolean => w.graph.lanelets.get(id)?.kind === 'link';
    // The lanes whose ways out may have changed: made or taken, and those into a junction built again.
    const lanes = new Set<LaneletId>();
    for (const change of changes) {
      for (const id of change.lanelets) lanes.add(id);
      for (const node of change.junctions) for (const id of w.graph.inbound.get(node) ?? []) lanes.add(id);
    }
    for (const id of [...lanes]) if (!isLink(id)) for (const u of this.into.get(id)?.keys() ?? []) lanes.add(u);
    const pairs: [LaneletId, LaneletId][] = [];
    const crossing: [LaneletId, LaneletId][] = [];
    const touched = new Set<number>();
    // Lanes taken away: their ways in and out with them
    for (const x of lanes) {
      const k = this.comp.get(x);
      if (k === undefined || isLink(x)) continue;
      this.work++;
      touched.add(k);
      const preds = [...this.into.get(x)?.keys() ?? []].filter((u) => u !== x && this.comp.get(u) === k);
      const succs = new Set(this.out.get(x)!.filter((v) => v !== x && this.comp.get(v) === k));
      for (const p of preds) for (const s of succs) if (p !== s) pairs.push([p, s]);
      for (const v of this.out.get(x)!) this.edge(x, v, -1);
      for (const [u, n] of [...this.into.get(x) ?? []]) {
        for (let i = 0; i < n; i++) this.edge(u, x, -1);
        const list = this.out.get(u);
        if (list) this.out.set(u, list.filter((v) => v !== x));
      }
      this.out.delete(x);
      this.into.delete(x);
      this.members.get(k)!.delete(x);
      if (!this.members.get(k)!.size) this.members.delete(k);
      this.comp.delete(x);
    }
    // Lanes made: each a component of its own until its ways join it to others.
    for (const x of lanes) {
      if (!isLink(x) || this.comp.has(x)) continue;
      const k = this.nextComp++;
      this.comp.set(x, k);
      this.members.set(k, new Set([x]));
      this.out.set(x, []);
      touched.add(k);
    }
    // Each lane's ways out as they are now: those gone and those new.
    for (const x of lanes) {
      if (!isLink(x)) continue;
      this.work++;
      const was = this.out.get(x)!;
      const now = this.next(w, x).filter((v) => this.comp.has(v));
      const left = new Map<LaneletId, number>();
      for (const v of now) left.set(v, (left.get(v) ?? 0) + 1);
      for (const v of was) {
        const n = left.get(v) ?? 0;
        if (n > 0) { left.set(v, n - 1); continue; }
        if (this.comp.get(v) === this.comp.get(x)) pairs.push([x, v]);
        this.edge(x, v, -1);
      }
      for (const [v, n] of left) for (let i = 0; i < n; i++) {
        this.edge(x, v, 1);
        if (this.comp.get(v) !== this.comp.get(x)) crossing.push([x, v]);
      }
      this.out.set(x, now);
      touched.add(this.comp.get(x)!);
    }
    // Splits: a component whose cut ends no longer reach each other is searched again, alone.
    const split = new Set<number>();
    for (const [u, v] of pairs) {
      const k = this.comp.get(u);
      if (k === undefined || this.comp.get(v) !== k || split.has(k)) continue;
      if (!this.reaches(u, v)) split.add(k);
    }
    for (const k of split) {
      const inK = this.members.get(k);
      if (!inK) continue;
      const lists = this.tarjan([...inK], (id) => inK.has(id));
      if (lists.length < 2) continue;
      this.retag([...inK], () => { this.members.delete(k); for (const list of lists) touched.add(this.label(list)); });
    }
    // Merges: the components on a cycle through a way added between two of them.
    for (const [u, v] of crossing) {
      const cu = this.comp.get(u), cv = this.comp.get(v);
      if (cu === undefined || cv === undefined || cu === cv) continue;
      const ahead = this.walkCond(cv, this.condOut, null);
      if (!ahead.has(cu)) continue;
      const cycle = this.walkCond(cu, this.condIn, ahead);
      const lanesOf = [...cycle].flatMap((c) => [...this.members.get(c) ?? []]);
      this.retag(lanesOf, () => { for (const c of cycle) this.members.delete(c); touched.add(this.label(lanesOf)); });
    }
    // The road ends forgotten for what changed and everything upstream of it.
    for (const c of touched) this.exitsMemo.delete(c);
    const live = [...touched].filter((c) => this.members.has(c));
    for (const c of this.walkCondMany(live, this.condIn)) this.exitsMemo.delete(c);
  }

  /** A link's ways out this body takes: the movements it fits, and the lane changes beside it. */
  private next(w: ReachWorld, lane: LaneletId): LaneletId[] {
    const out: LaneletId[] = [];
    for (const id of w.graph.exitsOf(lane)) {
      const connector = w.connector(id);
      if (connector && connector.maxBodyClass >= this.body && connector.toLane && w.graph.lanelets.get(connector.toLane)?.kind === 'link') out.push(connector.toLane);
    }
    for (const sibling of w.graph.siblingLanes(lane)) if (w.graph.lanelets.get(sibling)?.kind === 'link') out.push(sibling);
    return out;
  }

  /** Whether `u` reaches `v` now: a search from each end at once, the smaller side giving out first when it does not. */
  private reaches(u: LaneletId, v: LaneletId): boolean {
    if (u === v) return true;
    const fwd = new Set([u]), back = new Set([v]);
    let fq = [u], bq = [v];
    while (fq.length && bq.length) {
      if (fq.length <= bq.length) {
        const next: LaneletId[] = [];
        for (const x of fq) for (const y of this.out.get(x) ?? []) {
          if (back.has(y)) return true;
          if (!fwd.has(y)) { fwd.add(y); next.push(y); this.work++; }
        }
        fq = next;
      } else {
        const next: LaneletId[] = [];
        for (const x of bq) for (const y of this.into.get(x)?.keys() ?? []) {
          if (fwd.has(y)) return true;
          if (!back.has(y)) { back.add(y); next.push(y); this.work++; }
        }
        bq = next;
      }
    }
    return false;
  }

  /** Tarjan's components of `lanes` (iterative), over the ways out that stay within `inSet`. */
  private tarjan(lanes: readonly LaneletId[], inSet: (id: LaneletId) => boolean): LaneletId[][] {
    const order = new Map<LaneletId, number>(), low = new Map<LaneletId, number>();
    const stack: LaneletId[] = [], onStack = new Set<LaneletId>();
    const out: LaneletId[][] = [];
    let counter = 0;
    for (const root of lanes) {
      if (order.has(root)) continue;
      const frames: { lane: LaneletId; next: LaneletId[]; at: number }[] = [];
      const open = (lane: LaneletId): void => {
        this.work++;
        order.set(lane, counter); low.set(lane, counter); counter++;
        stack.push(lane); onStack.add(lane);
        frames.push({ lane, next: (this.out.get(lane) ?? []).filter(inSet), at: 0 });
      };
      open(root);
      while (frames.length) {
        const f = frames[frames.length - 1]!;
        if (f.at < f.next.length) {
          const to = f.next[f.at++]!;
          if (!order.has(to)) open(to);
          else if (onStack.has(to)) low.set(f.lane, Math.min(low.get(f.lane)!, order.get(to)!));
          continue;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) low.set(parent.lane, Math.min(low.get(parent.lane)!, low.get(f.lane)!));
        if (low.get(f.lane) !== order.get(f.lane)) continue;
        const members: LaneletId[] = [];
        while (stack.length) {
          const lane = stack.pop()!;
          onStack.delete(lane);
          members.push(lane);
          if (lane === f.lane) break;
        }
        out.push(members);
      }
    }
    return out;
  }

  /** A new component of these lanes; its id. */
  private label(lanes: readonly LaneletId[]): number {
    const k = this.nextComp++;
    this.members.set(k, new Set(lanes));
    for (const id of lanes) this.comp.set(id, k);
    return k;
  }

  /** Lanes given new components by `relabel`, the condensation's counts of their ways taken out before and put back after. */
  private retag(lanes: readonly LaneletId[], relabel: () => void): void {
    const set = new Set(lanes);
    const ways: [LaneletId, LaneletId][] = [];
    for (const x of lanes) {
      for (const v of this.out.get(x) ?? []) ways.push([x, v]);
      for (const [u, n] of this.into.get(x) ?? []) if (!set.has(u)) for (let i = 0; i < n; i++) ways.push([u, x]);
    }
    for (const [a, b] of ways) this.cond(this.comp.get(a)!, this.comp.get(b)!, -1);
    relabel();
    for (const [a, b] of ways) this.cond(this.comp.get(a)!, this.comp.get(b)!, 1);
  }

  /** A way out added (+1) or taken (-1): the ways in, and the condensation between two components. */
  private edge(u: LaneletId, v: LaneletId, n: 1 | -1): void {
    this.countIn(v, u, n);
    const cu = this.comp.get(u), cv = this.comp.get(v);
    if (cu !== undefined && cv !== undefined) this.cond(cu, cv, n);
  }

  private countIn(v: LaneletId, u: LaneletId, n: number): void {
    let m = this.into.get(v);
    if (!m) this.into.set(v, m = new Map());
    const left = (m.get(u) ?? 0) + n;
    if (left > 0) m.set(u, left); else m.delete(u);
  }

  private cond(a: number, b: number, n: number): void {
    if (a === b) return;
    bump(this.condOut, a, b, n);
    bump(this.condIn, b, a, n);
  }

  /** The components reached from `start` over `ways` (itself included), within `within` when given. */
  private walkCond(start: number, ways: Map<number, Map<number, number>>, within: ReadonlySet<number> | null): Set<number> {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const c = queue.pop()!;
      for (const d of ways.get(c)?.keys() ?? []) {
        if (seen.has(d) || (within && !within.has(d))) continue;
        seen.add(d);
        queue.push(d);
      }
    }
    return seen;
  }

  private walkCondMany(starts: readonly number[], ways: Map<number, Map<number, number>>): Set<number> {
    const seen = new Set<number>();
    for (const s of starts) if (!seen.has(s)) for (const c of this.walkCond(s, ways, null)) seen.add(c);
    return seen;
  }

  /** A component's road ends: those of its lanes, and those of the components it leads to (summed first). */
  private exitsOf(w: ReachWorld, root: number): readonly LaneletId[] {
    const known = this.exitsMemo.get(root);
    if (known) return known;
    const stack: { c: number; ahead: number[]; at: number }[] = [{ c: root, ahead: [...this.condOut.get(root)?.keys() ?? []], at: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      if (f.at < f.ahead.length) {
        const d = f.ahead[f.at++]!;
        if (!this.exitsMemo.has(d)) stack.push({ c: d, ahead: [...this.condOut.get(d)?.keys() ?? []], at: 0 });
        continue;
      }
      stack.pop();
      const own: LaneletId[] = [];
      for (const lane of this.members.get(f.c) ?? []) if (boundaryExit(w, lane)) own.push(lane);
      // One component beyond and none of its own: the same list, shared.
      if (!own.length && f.ahead.length === 1) { this.exitsMemo.set(f.c, this.exitsMemo.get(f.ahead[0]!)!); continue; }
      const all = new Set<LaneletId>(own);
      for (const d of f.ahead) for (const id of this.exitsMemo.get(d)!) all.add(id);
      this.exitsMemo.set(f.c, [...all].sort());
    }
    return this.exitsMemo.get(root)!;
  }
}

function bump(ways: Map<number, Map<number, number>>, a: number, b: number, n: number): void {
  let m = ways.get(a);
  if (!m) ways.set(a, m = new Map());
  const left = (m.get(b) ?? 0) + n;
  if (left > 0) m.set(b, left);
  else { m.delete(b); if (!m.size) ways.delete(a); }
}

/** A lane that leaves the map: a link into a road end at the edge, with no way on. */
export function boundaryExit(w: ReachWorld, id: LaneletId): boolean {
  const lane = w.lanelet(id);
  return !!lane && lane.kind === 'link' && lane.to !== undefined &&
    w.doc.mapEdge(lane.to) && w.graph.exitsOf(id).length === 0;
}

/** Each body class's reach, kept with the world (`SimWorld.laneReaches`). */
export class LaneReaches {
  private readonly bodies = new Map<BodyClass, BodyReach>();
  private seen: object | null = null;

  /** The road ends a link lane can reach, for a body (its own included when it is one). */
  exitsFrom(w: ReachWorld, start: LaneletId, body: BodyClass): readonly LaneletId[] {
    this.follow(w);
    let reach = this.bodies.get(body);
    if (!reach) { this.bodies.set(body, reach = new BodyReach(body)); reach.buildAll(w); }
    return reach.exitsFrom(w, start);
  }

  /** Whether a link lane can lead to another for a body (false: no route, DO NOT search the graph for one); true when it may, or when it cannot be said. */
  mayReach(w: ReachWorld, start: LaneletId, goal: LaneletId, body: BodyClass): boolean {
    this.follow(w);
    let reach = this.bodies.get(body);
    if (!reach) { this.bodies.set(body, reach = new BodyReach(body)); reach.buildAll(w); }
    return reach.reachesFrom(start, goal) !== false;
  }

  /** DO NOT leave the graph's changes to the first vehicle made after them (its tick paid for every body's reach): followed where the topology is built again (`SimWorld.rebuildVehicleTopology`). */
  follow(w: ReachWorld): void {
    const changes = w.topologyLog.since(this.seen);
    this.seen = w.topologyLog.state;
    if (changes === null) this.bodies.clear();
    else if (changes.length) for (const reach of this.bodies.values()) reach.follow(w, changes);
  }

  /** Lanes looked at since made, over the body classes (the scale tests' count). */
  get work(): number {
    let n = 0;
    for (const reach of this.bodies.values()) n += reach.work;
    return n;
  }
}
