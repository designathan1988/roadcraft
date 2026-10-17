import { measureHitch } from '@core/hitch';
import { type ListPart, RoadDoc, type SerializedDoc } from '@world/doc';
import { sideOf, type DocPatch } from '@world/docImage';
import type { Network } from '@world/network';
import { repairNearConnections } from './repair';

/** Undo and redo by the records an edit changed. */
export class History {
  private readonly undoStack: DocPatch[] = [];
  private readonly redoStack: DocPatch[] = [];
  /** The document whose edit is open (`RoadDoc.beginEdit`), or null. */
  private open: RoadDoc | null = null;
  /** The group the steps closed now join (`grouped`), and each grouped step's: undone and redone together, dropped together. */
  private group: number | null = null;
  private readonly groupOf = new WeakMap<DocPatch, number>();

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

  /** The steps closed from now joined into `group` (a long road laid in parts, `RoadTool.layHeld`), until `null`: one undo for them all. */
  grouped(group: number | null): void {
    this.settle();
    this.group = group;
  }

  /** Puts back the document as it was before the last step (every step of its group); false with nothing to undo. */
  undo(doc: RoadDoc): boolean {
    this.settle();
    const group = this.groupAt(this.undoStack);
    let undone = false;
    do {
      let patch = this.undoStack.pop();
      if (!patch) break;
      // A step that replaced the whole map keeps the map after only from now, for its redo (`RoadDoc.endEdit`).
      if (patch.whole && !patch.whole.after) {
        const kept = this.groupOf.get(patch);
        patch = { ...patch, whole: { before: patch.whole.before, after: doc.toJSON() } };
        if (kept !== undefined) this.groupOf.set(patch, kept);
      }
      doc.restore(sideOf(patch, 'before'));
      this.redoStack.push(patch);
      undone = true;
    } while (group !== undefined && this.groupAt(this.undoStack) === group);
    return undone;
  }

  /** Puts back the step last undone (every step of its group); false with nothing to redo. */
  redo(doc: RoadDoc): boolean {
    this.settle();
    const group = this.groupAt(this.redoStack);
    let redone = false;
    do {
      const patch = this.redoStack.pop();
      if (!patch) break;
      doc.restore(sideOf(patch, 'after'));
      this.undoStack.push(patch);
      redone = true;
    } while (group !== undefined && this.groupAt(this.redoStack) === group);
    this.trim();
    return redone;
  }

  /** The group of a stack's top step, undefined for one of its own. */
  private groupAt(stack: readonly DocPatch[]): number | undefined {
    const top = stack[stack.length - 1];
    return top ? this.groupOf.get(top) : undefined;
  }

  /** The steps of the groups `gone` steps were in, dropped too: DO NOT leave half a group to undo (a long road's parts, one undo for them all). */
  private dropGroupsOf(gone: readonly DocPatch[]): number {
    const groups = new Set<number>();
    for (const p of gone) { const g = this.groupOf.get(p); if (g !== undefined) groups.add(g); }
    if (!groups.size) return 0;
    const kept = (p: DocPatch): boolean => !groups.has(this.groupOf.get(p) ?? -1);
    const undo = this.undoStack.filter(kept), redo = this.redoStack.filter(kept);
    this.undoStack.length = 0;
    this.undoStack.push(...undo);
    this.redoStack.length = 0;
    this.redoStack.push(...redo);
    return groups.size;
  }

  /** A tile let go of the page (`worldStreamer.ts`): a step naming a record or an item of it can no longer be undone or redone
   *  - such an undo step is dropped with every older one, the redo steps all; the steps kept have their stretches of the lists shifted past the items that went (`removedAt`, indices before they went). */
  letGoTile(touches: (record: { readonly part: string; readonly id: number; readonly value: unknown }) => boolean, itemIn: (item: unknown) => boolean,
    removedAt: ReadonlyMap<ListPart, readonly number[]>): number {
    this.settle();
    // How many groups went (a long road's parts, `grouped`): the player told (`main.ts`).
    let groups = 0;
    const named = (p: DocPatch): boolean => p.whole !== undefined
      || p.records.some((r) => touches({ part: r.part, id: r.id, value: r.before }) || touches({ part: r.part, id: r.id, value: r.after }))
      || p.lists.some((l) => l.before.some(itemIn) || l.after.some(itemIn));
    for (let k = this.undoStack.length - 1; k >= 0; k--) {
      if (!named(this.undoStack[k]!)) continue;
      groups = this.dropGroupsOf(this.undoStack.splice(0, k + 1));
      break;
    }
    if (this.redoStack.some(named)) this.redoStack.length = 0;
    if (!removedAt.size) return groups;
    const shift = (p: DocPatch): DocPatch => (p.lists.length === 0 ? p : {
      ...p,
      lists: p.lists.map((l) => {
        const gone = removedAt.get(l.part);
        if (!gone?.length) return l;
        let before = 0;
        for (const at of gone) if (at < l.start) before++;
        return before ? { ...l, start: l.start - before } : l;
      }),
    });
    for (let k = 0; k < this.undoStack.length; k++) this.undoStack[k] = shift(this.undoStack[k]!);
    for (let k = 0; k < this.redoStack.length; k++) this.redoStack[k] = shift(this.redoStack[k]!);
    return groups;
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
    measureHitch('hitch:history/commit', start);
    if (!patch) return false;
    if (this.group !== null) this.groupOf.set(patch, this.group);
    this.undoStack.push(patch);
    this.redoStack.length = 0;
    this.trim();
    return true;
  }

  /** Drops the OLDEST undo steps past the count or the byte budget; the newest always stays. */
  private trim(): void {
    const gone: DocPatch[] = [];
    while (this.undoStack.length > this.limit) gone.push(this.undoStack.shift()!);
    while (this.undoStack.length > 1 && this.bytes > this.byteBudget) gone.push(this.undoStack.shift()!);
    this.dropGroupsOf(gone);
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
