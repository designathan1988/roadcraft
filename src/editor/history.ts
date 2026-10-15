import { RoadDoc, type SerializedDoc } from '@world/doc';
import { sideOf, type DocPatch } from '@world/docImage';
import type { Network } from '@world/network';
import { repairNearConnections } from './repair';

/** Undo and redo by the records an edit changed. */
export class History {
  private readonly undoStack: DocPatch[] = [];
  private readonly redoStack: DocPatch[] = [];
  /** The document whose edit is open (`RoadDoc.beginEdit`), or null. */
  private open: RoadDoc | null = null;

  /** `limit` steps, and at most `byteBudget` bytes of patches across both stacks. */
  constructor(private readonly limit = 60, private readonly byteBudget = 96 * 1024 * 1024) {}

  /** Bytes currently held, approximately (UTF-16 of the patches). */
  get bytes(): number {
    let total = 0;
    for (const p of this.undoStack) total += p.bytes;
    for (const p of this.redoStack) total += p.bytes;
    return total;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.open !== null;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** An edit begins: the one before it is closed (or what changed on its own taken in). */
  begin(doc: RoadDoc): void {
    this.settle();
    doc.beginEdit();
    this.open = doc;
  }

  /** The edit ends: its patch becomes a step; whether it changed anything. */
  end(doc: RoadDoc): boolean {
    if (this.open !== doc) return false;
    return this.close();
  }

  /** Puts back the document as it was before the last step; false with nothing to undo. */
  undo(doc: RoadDoc): boolean {
    this.settle();
    let patch = this.undoStack.pop();
    if (!patch) return false;
    // A step that replaced the whole map keeps the map after only from now, for its redo (`RoadDoc.endEdit`).
    if (patch.whole && !patch.whole.after) patch = { ...patch, whole: { before: patch.whole.before, after: doc.toJSON() } };
    doc.restore(sideOf(patch, 'before'));
    this.redoStack.push(patch);
    return true;
  }

  /** Puts back the step last undone; false with nothing to redo. */
  redo(doc: RoadDoc): boolean {
    this.settle();
    const patch = this.redoStack.pop();
    if (!patch) return false;
    doc.restore(sideOf(patch, 'after'));
    this.undoStack.push(patch);
    this.trim();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.open?.endEdit();
    this.open = null;
  }

  /** The open edit closed as a step: what it changed, written as it happened. */
  private settle(): void {
    if (this.open) this.close();
  }

  private close(): boolean {
    const doc = this.open!;
    this.open = null;
    const start = performance.now();
    const patch = doc.endEdit();
    performance.measure('hitch:history/commit', { start, end: performance.now() });
    if (!patch) return false;
    this.undoStack.push(patch);
    this.redoStack.length = 0;
    this.trim();
    return true;
  }

  /** Drops the OLDEST undo steps past the count or the byte budget; the newest always stays. */
  private trim(): void {
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    while (this.undoStack.length > 1 && this.bytes > this.byteBudget) this.undoStack.shift();
  }
}

/** The network after an undo or a redo: rebuilt only when the roads moved */
export function followNetwork(doc: RoadDoc, net: Network): void {
  if (net.revision !== doc.revision) net.rebuild();
}

/** A document as the text the autosave writes. */
export function serialize(doc: RoadDoc): string {
  return doc.toText();
}

/** Loads data from OUTSIDE the running model - the autosave at boot, an imported file: legacy repairs apply */
export function restoreInto(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data);
  // A map opened is built whole, nothing taken from the map before it (`Network.rebuild`)
  net.rebuild({ full: true });
  repairNearConnections(target, net);
}

/** Restores a document saved by the model itself exactly (a failed load put back, a gesture cancelled). */
export function restoreSnapshot(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data, { repair: false });
  // `replaceWith` moves `revision` only when the roads differ
  if (net.revision !== target.revision) net.rebuild();
}
