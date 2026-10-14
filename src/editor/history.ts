import { RoadDoc, type SerializedDoc } from '@world/doc';
import { DocImage, sideOf, type DocPatch } from '@world/docImage';
import type { Network } from '@world/network';
import { repairNearConnections } from './repair';

/**
 * Undo and redo by the records an edit changed (docs/ARCHITECTURE.md 5).
 *
 * Each step was a snapshot of the whole document as text, written before the
 * edit, and every edit wrote the whole document again after it to see whether
 * anything changed (12.7 MB a time on a city of 1 530 buildings). A step is
 * now a patch (`world/docImage.ts`): the records, list stretches and values
 * the edit changed, as they were and as they are, found by comparing the
 * document with the image of it last committed, only where the diary says
 * something moved.
 *
 * An edit is `begin` ... `end`. A gesture that only begins (a brush stroke, a
 * slider dragged) is closed by whatever comes next: the next `begin`, an undo,
 * a redo. A change made with no edit open (a building growing on its own) is
 * taken into the image at the next `begin` without a step of its own, as the
 * snapshot taken then would have held it.
 * Derived geometry, lanelets, signal plans and agents are rebuilt from the
 * document, so it is the one thing to keep.
 */
export class History {
  private readonly undoStack: DocPatch[] = [];
  private readonly redoStack: DocPatch[] = [];
  /** The document as last committed; taken at the first edit. */
  private image: DocImage | null = null;
  /** An edit has begun and not ended. */
  private open = false;

  /**
   * `limit` steps, and at most `byteBudget` bytes of patches across both
   * stacks. A count alone let 120 copies of a large city (thousands of terrain
   * stamps, every building) grow to hundreds of megabytes.
   */
  constructor(private readonly limit = 60, private readonly byteBudget = 96 * 1024 * 1024) {}

  /** Bytes currently held, approximately (UTF-16 of the patches). */
  get bytes(): number {
    let total = 0;
    for (const p of this.undoStack) total += p.bytes;
    for (const p of this.redoStack) total += p.bytes;
    return total;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.open;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** An edit begins: the one before it is closed (or what changed on its own taken in). */
  begin(doc: RoadDoc): void {
    this.settle(doc);
    this.open = true;
  }

  /** The edit ends: its patch becomes a step; whether it changed anything. */
  end(doc: RoadDoc): boolean {
    const changed = this.close(doc);
    this.open = false;
    return changed;
  }

  /** Puts back the document as it was before the last step; false with nothing to undo. */
  undo(doc: RoadDoc): boolean {
    this.settle(doc);
    const patch = this.undoStack.pop();
    if (!patch) return false;
    doc.restore(sideOf(patch, 'before'));
    this.image!.absorb(doc);
    this.redoStack.push(patch);
    return true;
  }

  /** Puts back the step last undone; false with nothing to redo. */
  redo(doc: RoadDoc): boolean {
    this.settle(doc);
    const patch = this.redoStack.pop();
    if (!patch) return false;
    doc.restore(sideOf(patch, 'after'));
    this.image!.absorb(doc);
    this.undoStack.push(patch);
    this.trim();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.image = null;
    this.open = false;
  }

  /** The open edit closed as a step, or, with none open, what changed on its own taken into the image. */
  private settle(doc: RoadDoc): void {
    if (this.open) {
      this.close(doc);
      this.open = false;
    } else if (this.image) this.timed('history/absorb', () => this.image!.absorb(doc));
    else this.image = this.timed('history/image', () => new DocImage(doc));
  }

  private close(doc: RoadDoc): boolean {
    this.image ??= this.timed('history/image', () => new DocImage(doc));
    const patch = this.timed('history/commit', () => this.image!.commit(doc));
    if (!patch) return false;
    this.undoStack.push(patch);
    this.redoStack.length = 0;
    this.trim();
    return true;
  }

  /** `work`, timed in the page's measures (`hitch:` entries, docs/source/performance.md). */
  private timed<T>(what: string, work: () => T): T {
    const start = performance.now();
    const out = work();
    performance.measure(`hitch:${what}`, { start, end: performance.now() });
    return out;
  }

  /** Drops the OLDEST undo steps past the count or the byte budget; the newest always stays. */
  private trim(): void {
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    while (this.undoStack.length > 1 && this.bytes > this.byteBudget) this.undoStack.shift();
  }
}

/**
 * The network after an undo or a redo: rebuilt only when the roads moved (a
 * storey, a pole or a brush dab leaves it, and everything built on it, alone).
 */
export function followNetwork(doc: RoadDoc, net: Network): void {
  if (net.revision !== doc.revision) net.rebuild();
}

/** A document as the text the autosave writes. */
export function serialize(doc: RoadDoc): string {
  return doc.toText();
}

/**
 * Loads data from OUTSIDE the running model - the autosave at boot, an
 * imported file: legacy repairs apply (coincident nodes merged, dead ends
 * left inside another road joined to it).
 */
export function restoreInto(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data);
  // A map opened is built whole, nothing taken from the map before it
  // (`Network.rebuild`, docs/source/VIAS.md V0); edits after it are incremental.
  net.rebuild({ full: true });
  repairNearConnections(target, net);
}

/**
 * Restores a document saved by the model itself exactly (a failed load put
 * back, a gesture cancelled). Running the legacy repair here made undo edit
 * the map: a dead end the Move tool had left inside a road was split into a
 * junction the player never drew, and undo and redo stopped being inverses.
 */
export function restoreSnapshot(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data, { repair: false });
  // `replaceWith` moves `revision` only when the roads differ: undoing a storey,
  // a pole or a brush dab leaves the network, and everything built on it, alone.
  if (net.revision !== target.revision) net.rebuild();
}
