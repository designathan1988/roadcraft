import { RoadDoc, type SerializedDoc } from '@world/doc';
import { DocImage, sideOf, type DocPatch } from '@world/docImage';
import type { Network } from '@world/network';
import { repairNearConnections } from './repair';

/** Undo and redo by the records an edit changed. */
export class History {
  private readonly undoStack: DocPatch[] = [];
  private readonly redoStack: DocPatch[] = [];
  /** The document as last committed; taken at the first edit. */
  private image: DocImage | null = null;
  /** An edit has begun and not ended. */
  private open = false;

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

  /** `work`, timed in the page's measures (`hitch:` entries). */
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
