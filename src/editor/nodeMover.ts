import type { Vec2 } from '@core/vec2';
import { COARSE_EPS } from '@core/scalar';
import type { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import type { Network } from '@world/network';
import { type DraftResult, moveNodeChecked } from './commit';
import { restoreSnapshot } from './history';

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
 * document, and dropped as one undo step. The document as it was when the
 * drag began is kept (a memento): each step through a spot where an
 * incident curve would be too tight flattened it for good (`fitCurve`), so
 * cancelling restores it, and the drop restores it before moving the node
 * once, from where it started to where it lands.
 */
export class NodeMover {
  private drag: { node: NodeId; origin: Vec2; before: ReturnType<RoadDoc['toJSON']> } | null = null;
  private lastPreview = -Infinity;

  constructor(private readonly host: NodeMoverHost) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  gesture(): string | null {
    return this.drag ? 'via: movendo um nó' : null;
  }

  /** A press on `node`: the drag begins (false when there is no such node). */
  grab(node: NodeId): boolean {
    const at = this.host.doc.node(node);
    if (!at) return false;
    this.drag = { node, origin: { x: at.x, y: at.y }, before: this.host.doc.toJSON() };
    return true;
  }

  /** The pointer moved: the node follows it, live. True when a node is being dragged. */
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

  /** The drag cut short: the document as it was before it. */
  cancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    restoreSnapshot(this.host.doc, drag.before, this.host.net);
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
    // Back to the document as it was - curves included - then, if the drag
    // counts, one move from there to the drop point as one undo step.
    restoreSnapshot(doc, drag.before, net);
    if (!changed || !commit) {
      host.settleTopology();
      return;
    }
    // The drop is reconciled like a drawn road: onto a node it joins it,
    // across a road it makes a junction, and a drop that would leave a stub
    // or cross a road at the wrong height is refused.
    // Judged by the editing rules too (`editRules.ts`): a drop that makes a
    // junction too sharp or too tight, or lays a road on another, is refused.
    let refused: DraftResult['reason'] | undefined;
    host.mutate(() => {
      const result = moveNodeChecked(doc, net, drag.node, now);
      if (result.committed) return true;
      refused = result.reason === 'duplicate' ? undefined : result.reason;
      restoreSnapshot(doc, drag.before, net);
      return false;
    });
    if (refused) {
      host.hint(refused === 'clearance' ? 'hint.move.clearance'
        : refused === 'tooShort' || refused === 'degenerate' ? 'hint.move.tooShort' : `hint.rule.${refused}`);
    }
  }
}
