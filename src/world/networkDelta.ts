import type { ChangeRect } from './changes';
import type { NodeId, SegmentId } from './ids';

/** What one rebuild of the network changed (`Network.rebuild`) */
export interface NetworkDelta {
  readonly segments: ReadonlySet<SegmentId>;
  readonly nodes: ReadonlySet<NodeId>;
  readonly rects: readonly ChangeRect[];
}

/** One rebuild, or several merged: from one state of the network to another, and what changed; `null`, everything */
interface DeltaEdge {
  readonly from: WeakRef<object>;
  readonly to: WeakRef<object>;
  readonly delta: NetworkDelta | null;
}

/** Edges at which the history is first merged; past it, again whenever it has doubled since. */
const MERGE_FROM = 64;

/** DO NOT keep the last N rebuilds only */
export class DeltaLog {
  /** The current state. A fresh object per rebuild: only its identity is read. */
  state: object = {};
  /** The current state's one reference: every edge touching a state shares it, so a state gone is still known as one. */
  private stateRef = new WeakRef(this.state);
  private edges: DeltaEdge[] = [];
  /** How long the history was after its last merge (`advance`). */
  private merged = 0;
  /** The network's roads and nodes now (`advance`): a merged change past it is held as everything (null). */
  private size = Infinity;
  /** What the edges' changes hold (`weightOf`). */
  private weight = 0;

  /** Records a rebuild that moved the network to a new state; `size`, the roads and nodes it holds now. */
  advance(delta: NetworkDelta | null, size = Infinity): void {
    this.size = size;
    const to = {};
    const toRef = new WeakRef(to);
    this.edges.push({ from: this.stateRef, to: toRef, delta });
    this.weight += weightOf(delta);
    this.state = to;
    this.stateRef = toRef;
    // Merged when it has doubled, or when what it holds passes twice the network: the camera crossing tiles fills it with whole tiles' roads.
    if (this.edges.length >= Math.max(MERGE_FROM, this.merged * 2) || this.weight > 2 * size) {
      this.merge(() => true);
      this.merged = this.edges.length;
    }
    // Still past it, every state held: the oldest rebuilds let go, their readers told everything changed (`since` null).
    while (this.weight > 2 * size && this.edges.length > 1) this.weight -= weightOf(this.edges.shift()!.delta);
  }

  /** Takes another log's current state and every rebuild it remembers (`Network.adopt`). */
  takeFrom(other: DeltaLog): void {
    if (other === this) return;
    const known = new Set(this.edges);
    const merged = this.edges.slice();
    for (const edge of other.edges) if (!known.has(edge)) merged.push(edge);
    this.edges = merged;
    this.weight = merged.reduce((n, e) => n + weightOf(e.delta), 0);
    this.state = other.state;
    this.stateRef = other.stateRef;
  }

  /** Merges away the states no reader holds: collected, or not `held` */
  merge(held: (state: object) => boolean): void {
    const alive = (ref: WeakRef<object>): boolean => {
      if (ref === this.stateRef) return true;
      const state = ref.deref();
      return state !== undefined && held(state);
    };
    for (let changed = true; changed;) {
      changed = false;
      const touching = new Map<WeakRef<object>, DeltaEdge[]>();
      for (const edge of this.edges) {
        for (const ref of [edge.from, edge.to]) {
          const list = touching.get(ref);
          if (list) list.push(edge); else touching.set(ref, [edge]);
        }
      }
      const gone = new Set<DeltaEdge>();
      const added: DeltaEdge[] = [];
      for (const [ref, list] of touching) {
        if (alive(ref) || list.length > 2 || list.some((e) => gone.has(e))) continue;
        changed = true;
        for (const e of list) gone.add(e);
        if (list.length < 2) continue;
        const [a, b] = list as [DeltaEdge, DeltaEdge];
        const from = a.from === ref ? a.to : a.from, to = b.from === ref ? b.to : b.from;
        if (from !== to) added.push({ from, to, delta: union(a.delta, b.delta, this.size) });
      }
      if (changed) this.edges = [...this.edges.filter((e) => !gone.has(e)), ...added];
    }
    this.weight = this.edges.reduce((n, e) => n + weightOf(e.delta), 0);
  }

  /** Everything that changed between the state `from` and the current one, or `null` when that is not known */
  since(from: object | null): NetworkDelta | null {
    if (from === null) return null;
    if (from === this.state) return { segments: new Set(), nodes: new Set(), rects: [] };
    // Breadth first over the remembered rebuilds, both ways, by the states' references
    const via = new Map<WeakRef<object>, DeltaEdge | null>([[this.stateRef, null]]);
    const queue: WeakRef<object>[] = [this.stateRef];
    let start: WeakRef<object> | null = null;
    while (queue.length && !start) {
      const at = queue.shift()!;
      for (const edge of this.edges) {
        const next = edge.from === at ? edge.to : edge.to === at ? edge.from : null;
        if (next === null || via.has(next)) continue;
        via.set(next, edge);
        if (next.deref() === from) { start = next; break; }
        queue.push(next);
      }
    }
    if (!start) return null;
    const segments = new Set<SegmentId>(), nodes = new Set<NodeId>(), rects: ChangeRect[] = [];
    for (let at = start; at !== this.stateRef;) {
      const edge = via.get(at)!;
      if (edge.delta === null) return null;
      for (const s of edge.delta.segments) segments.add(s);
      for (const n of edge.delta.nodes) nodes.add(n);
      rects.push(...edge.delta.rects);
      at = edge.from === at ? edge.to : edge.from;
    }
    return { segments, nodes, rects };
  }
}

/** What a change holds: its roads, nodes and rectangles. */
const weightOf = (d: NetworkDelta | null): number => (d ? d.segments.size + d.nodes.size + d.rects.length : 0);

/** Two changes as one: every road, node and rectangle of both; `null` (everything) if either is, or if they name more roads and nodes than the network holds (`size`) */
/** DO NOT keep a merged change larger than the network: a reader that far behind reads it whole for no more (a reader holding an old state kept every road of every tile the camera passed, a heap snapshot of the simulation's worker over 22 tiles walked, 2026-10-17). */
function union(a: NetworkDelta | null, b: NetworkDelta | null, size: number): NetworkDelta | null {
  if (a === null || b === null) return null;
  const segments = new Set([...a.segments, ...b.segments]), nodes = new Set([...a.nodes, ...b.nodes]);
  if (segments.size + nodes.size > size) return null;
  return { segments, nodes, rects: [...a.rects, ...b.rects] };
}
