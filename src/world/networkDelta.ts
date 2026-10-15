import type { ChangeRect } from './changes';
import type { NodeId, SegmentId } from './ids';

/**
 * What one rebuild of the network changed (`Network.rebuild`): the roads
 * whose ribbon, trims, plate reach or record moved, added or gone; the
 * nodes whose junction, record or marks moved, added or gone; and the
 * rectangles those ribbons and junctions covered before and after. What is
 * derived from the network (the lanes, the conflict zones, the signals, the
 * zebras) reads it to redo only what an edit touched - the change a build
 * system propagates, item by item, instead of a revision that says only THAT
 * something changed somewhere (Mokhov, Mitchell and Peyton Jones, "Build
 * systems à la carte": a minimal build redoes a task only when one of its
 * inputs changed).
 */
export interface NetworkDelta {
  readonly segments: ReadonlySet<SegmentId>;
  readonly nodes: ReadonlySet<NodeId>;
  readonly rects: readonly ChangeRect[];
}

/**
 * One rebuild, or several merged: from one state of the network to another, and what changed;
 * `null`, everything (a load, a first build). The states are held weakly: the readers hold the
 * tokens they read, the history does not.
 */
interface DeltaEdge {
  readonly from: WeakRef<object>;
  readonly to: WeakRef<object>;
  readonly delta: NetworkDelta | null;
}

/** Edges at which the history is first merged; past it, again whenever it has doubled since. */
const MERGE_FROM = 64;

/**
 * The states a network has been in, as tokens, and the change between each
 * and the next: a reader keeps the token it last read and asks for what
 * changed since (`since`). A network may also go BACK to an earlier state -
 * an edit refused puts the network it had back (`editor/editRules.ts`
 * `guardRoadEdit`) - or take the state of a copy built ahead
 * (`editor/commit.ts`: the copy's own rebuilds); the change between two
 * states is the same both ways, so the history is an undirected chain of
 * rebuilds and `since` walks it from the reader's token to the current one.
 *
 * Nothing is forgotten by age: a state no reader holds any more (its token
 * collected) is merged away, the two rebuilds round it one change, their
 * union (`merge`) - so the history is as long as the tokens still held, and
 * a reader however far behind is told what changed. DO NOT keep the last N
 * rebuilds only: while the traffic's topology waited for its workers, a
 * generated city rebuilt the network past 64 states every few seconds, and
 * the lane graph, its conflicts, the walkways and the zebras of the whole
 * town were built again from nothing - frames of 3.3 s at 2 560 m (2026-10-15).
 */
export class DeltaLog {
  /** The current state. A fresh object per rebuild: only its identity is read. */
  state: object = {};
  /** The current state's one reference: every edge touching a state shares it, so a state gone is still known as one. */
  private stateRef = new WeakRef(this.state);
  private edges: DeltaEdge[] = [];
  /** How long the history was after its last merge (`advance`). */
  private merged = 0;

  /** Records a rebuild that moved the network to a new state. */
  advance(delta: NetworkDelta | null): void {
    const to = {};
    const toRef = new WeakRef(to);
    this.edges.push({ from: this.stateRef, to: toRef, delta });
    this.state = to;
    this.stateRef = toRef;
    if (this.edges.length >= Math.max(MERGE_FROM, this.merged * 2)) {
      this.merge(() => true);
      this.merged = this.edges.length;
    }
  }

  /** Takes another log's current state and every rebuild it remembers (`Network.adopt`). */
  takeFrom(other: DeltaLog): void {
    if (other === this) return;
    const known = new Set(this.edges);
    const merged = this.edges.slice();
    for (const edge of other.edges) if (!known.has(edge)) merged.push(edge);
    this.edges = merged;
    this.state = other.state;
    this.stateRef = other.stateRef;
  }

  /**
   * Merges away the states no reader holds: collected, or not `held` (tests pass their own; the
   * current state is always held). A state between two rebuilds becomes one rebuild carrying both
   * changes; a state at a loose end takes its rebuild with it (no reader can ask from there); a
   * state where the history branches is kept.
   */
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
        if (from !== to) added.push({ from, to, delta: union(a.delta, b.delta) });
      }
      if (changed) this.edges = [...this.edges.filter((e) => !gone.has(e)), ...added];
    }
  }

  /**
   * Everything that changed between the state `from` and the current one,
   * or `null` when that is not known (too far behind, a load in between, a
   * state this network never was in): the reader then takes everything as
   * changed. Empty when `from` is the current state.
   */
  since(from: object | null): NetworkDelta | null {
    if (from === null) return null;
    if (from === this.state) return { segments: new Set(), nodes: new Set(), rects: [] };
    // Breadth first over the remembered rebuilds, both ways, by the states' references: a state
    // collected but not merged yet is still a step of the way.
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

/** Two changes as one: every road, node and rectangle of both; `null` (everything) if either is. */
function union(a: NetworkDelta | null, b: NetworkDelta | null): NetworkDelta | null {
  if (a === null || b === null) return null;
  return { segments: new Set([...a.segments, ...b.segments]), nodes: new Set([...a.nodes, ...b.nodes]), rects: [...a.rects, ...b.rects] };
}
