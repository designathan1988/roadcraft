import type { LabPerson } from './record';

/** UNDO AND REDO OF THE WHOLE PERSON, as any editor keeps them: each change that settles (a build or an exact reshape) is a step; undo puts the
 *  person back as it was before it, redo puts the step back; a new change after an undo drops what could have been redone. The sculptors keep
 *  their own strokes while open; once a sculpt is done it is a step here like any other. */

/** How many steps are kept. */
const DEPTH = 80;

export class PersonHistory {
  private readonly past: LabPerson[] = [];
  private readonly future: LabPerson[] = [];
  /** The person as last settled, and its key (the name and the gallery's id aside). */
  private settled: LabPerson | null = null;
  private settledKey = '';

  private static key(p: LabPerson): string {
    return JSON.stringify({ ...p, spec: { ...p.spec, name: '' } });
  }

  /** The person has settled: a new step when it differs from the last one. */
  checkpoint(p: LabPerson): void {
    const key = PersonHistory.key(p);
    if (key === this.settledKey) return;
    if (this.settled) {
      this.past.push(this.settled);
      if (this.past.length > DEPTH) this.past.shift();
      this.future.length = 0;
    }
    this.settled = p;
    this.settledKey = key;
  }

  /** A person loaded or made new: its own history starts. */
  reset(p: LabPerson): void {
    this.past.length = 0;
    this.future.length = 0;
    this.settled = p;
    this.settledKey = PersonHistory.key(p);
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** The person before the last step, or null; `now` is what redo brings back. */
  undo(now: LabPerson): LabPerson | null {
    const p = this.past.pop();
    if (!p) return null;
    this.future.push(this.settled ?? now);
    this.settled = p;
    this.settledKey = PersonHistory.key(p);
    return p;
  }

  redo(): LabPerson | null {
    const p = this.future.pop();
    if (!p) return null;
    if (this.settled) this.past.push(this.settled);
    this.settled = p;
    this.settledKey = PersonHistory.key(p);
    return p;
  }
}
