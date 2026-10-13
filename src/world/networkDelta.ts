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

/** One rebuild: from one state of the network to the next, and what changed; `null`, everything (a load, a first build). */
interface DeltaEdge {
  readonly from: object;
  readonly to: object;
  readonly delta: NetworkDelta | null;
}

/** How many rebuilds are remembered; a reader further behind takes everything as changed. */
const KEPT = 64;

/**
 * The states a network has been in, as tokens, and the change between each
 * and the next: a reader keeps the token it last read and asks for what
 * changed since (`since`). A network may also go BACK to an earlier state -
 * an edit refused puts the network it had back (`editor/editRules.ts`
 * `guardRoadEdit`) - or take the state of a copy built ahead
 * (`editor/commit.ts`: the copy's own rebuilds); the change between two
 * states is the same both ways, so the history is an undirected chain of
 * rebuilds and `since` walks it from the reader's token to the current one.
 */
export class DeltaLog {
  /** The current state. A fresh object per rebuild: only its identity is read. */
  state: object = {};
  private edges: DeltaEdge[] = [];

  /** Records a rebuild that moved the network to a new state. */
  advance(delta: NetworkDelta | null): void {
    const to = {};
    this.edges.push({ from: this.state, to, delta });
    if (this.edges.length > KEPT) this.edges.splice(0, this.edges.length - KEPT);
    this.state = to;
  }

  /** Takes another log's current state and every rebuild it remembers (`Network.adopt`). */
  takeFrom(other: DeltaLog): void {
    if (other === this) return;
    const known = new Set(this.edges);
    const merged = this.edges.slice();
    for (const edge of other.edges) if (!known.has(edge)) merged.push(edge);
    this.edges = merged.length > KEPT ? merged.slice(merged.length - KEPT) : merged;
    this.state = other.state;
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
    // Breadth first over the remembered rebuilds, both ways.
    const via = new Map<object, DeltaEdge | null>([[this.state, null]]);
    const queue: object[] = [this.state];
    while (queue.length) {
      const at = queue.shift()!;
      if (at === from) break;
      for (const edge of this.edges) {
        const next = edge.from === at ? edge.to : edge.to === at ? edge.from : null;
        if (next === null || via.has(next)) continue;
        via.set(next, edge);
        queue.push(next);
      }
    }
    if (!via.has(from)) return null;
    const segments = new Set<SegmentId>(), nodes = new Set<NodeId>(), rects: ChangeRect[] = [];
    for (let at = from; at !== this.state;) {
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
