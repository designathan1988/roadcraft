import type { Vec2 } from '@core/vec2';
import { COARSE_EPS } from '@core/scalar';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import type { CurveShape } from '@core/bezier';
import type { Network } from '@world/network';
import { type DraftResult, moveNodeChecked } from './commit';

/** What the node mover reads of the game and does to it. */
export interface NodeMoverHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  /** The traffic's topology brought up to the network, when the document changed back. */
  settleTopology(): void;
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/**
 * Shortest interval between geometry rebuilds while a node is dragged: a
 * preview at 20 Hz is smoother than the eye needs, and it spares rebuilding
 * routes, signals and spatial indexes for pointer samples superseded at once.
 */
const PREVIEW_MIN_MS = 50;

/**
 * THE NODE MOVER (Move tool): a node dragged, previewed live in the
 * document, and dropped as one undo step. What a drag can change is kept
 * when it begins (a memento): the node's place and the curve of each road at
 * it - a step through a spot where an incident curve would be too tight
 * flattened it for good (`RoadDoc.fitCurve`) - so cancelling puts them back,
 * and the drop puts them back before moving the node once, from where it
 * started to where it lands. A refused drop is put back by `moveNodeChecked`.
 * DO NOT keep the whole document (`toJSON` at the press, `replaceFromJSON` at
 * the release): every drag serialised and parsed every building of the city.
 */
export class NodeMover {
  private drag: { node: NodeId; origin: Vec2; curves: ReadonlyMap<SegmentId, CurveShape | null> } | null = null;
  private lastPreview = -Infinity;

  constructor(private readonly host: NodeMoverHost) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** The gesture in progress, as a dictionary key (the interface translates it), or null. */
  gesture(): string | null {
    return this.drag ? 'gesture.move.node' : null;
  }

  /** A press on `node`: the drag begins (false when there is no such node). */
  grab(node: NodeId): boolean {
    const { doc } = this.host;
    const at = doc.node(node);
    if (!at) return false;
    const curves = new Map<SegmentId, CurveShape | null>();
    for (const id of at.incident) {
      const seg = doc.segment(id);
      if (seg) curves.set(id, seg.curve);
    }
    this.drag = { node, origin: { x: at.x, y: at.y }, curves };
    return true;
  }

  /**
   * The pointer moved: the node follows it, live. True when a node is being dragged.
   * @perInput Runs once a pointer move: nothing it reaches may walk the map.
   */
  move(world: Vec2): boolean {
    if (!this.drag) return false;
    this.host.doc.moveNode(this.drag.node, world);
    this.host.redraw();
    return true;
  }

  /**
   * Whether the network may be rebuilt for the preview at `now` (ms): no
   * sooner than the last rebuild's own cost allows. On a large network one
   * rebuild costs far more than 50 ms, and asking for one every 50 ms only
   * queued them until the pointer stopped.
   */
  previewDue(now: number, rebuildMs: number): boolean {
    if (now - this.lastPreview < Math.max(PREVIEW_MIN_MS, rebuildMs * 1.6)) return false;
    this.lastPreview = now;
    return true;
  }

  /** The drag cut short: the node and its roads as they were before it. */
  cancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.putBack(drag);
    this.host.settleTopology();
  }

  /** The pointer let go: the move recorded as one undo step (`commit` false: dropped). */
  drop(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const { host } = this;
    const { doc, net } = host;
    const node = doc.node(drag.node);
    if (!node) return;
    const now = { x: node.x, y: node.y };
    const changed = Math.hypot(now.x - drag.origin.x, now.y - drag.origin.y) > COARSE_EPS;
    // Back to the roads as they were - curves included - then, if the drag
    // counts, one move from there to the drop point as one undo step.
    this.putBack(drag);
    if (!changed || !commit) {
      host.settleTopology();
      return;
    }
    // The drop is reconciled like a drawn road: onto a node it joins it,
    // across a road it makes a junction, and a drop that would leave a stub
    // or cross a road at the wrong height is refused.
    // Judged by the editing rules too (`editRules.ts`): a drop that makes a
    // junction too sharp or too tight, or lays a road on another, is refused,
    // and `moveNodeChecked` puts the roads back itself.
    let refused: DraftResult['reason'] | undefined;
    host.mutate(() => {
      const result = moveNodeChecked(doc, net, drag.node, now);
      if (result.committed) return true;
      refused = result.reason === 'duplicate' ? undefined : result.reason;
      return false;
    });
    if (refused) {
      host.hint(refused === 'clearance' ? 'hint.move.clearance'
        : refused === 'tooShort' || refused === 'degenerate' ? 'hint.move.tooShort' : `hint.rule.${refused}`);
    }
  }

  /** The node back where the drag found it, each of its roads with the curve it had then; the network after them. */
  private putBack(drag: NonNullable<NodeMover['drag']>): void {
    const { doc, net } = this.host;
    doc.moveNode(drag.node, drag.origin);
    for (const [id, curve] of drag.curves) {
      if (doc.segment(id) && doc.segment(id)!.curve !== curve) doc.setSegmentCurve(id, curve);
    }
    if (net.revision !== doc.revision) net.rebuild();
  }
}
