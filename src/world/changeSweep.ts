import type { ChangeJournal, ChangeKind, ChangeRect } from './changes';

/** Side of a cell of `ChangeSweep`'s filing, world units. */
const SWEEP_CELL = 64; // world units (1 m)
/** A rectangle covering more cells than this is taken as the whole map: the sweep answers "changed" everywhere. */
const SWEEP_MAX_CELLS = 4096;

/**
 * The diary's new entries of some kinds read ONCE for many readers of
 * points (every parked car, every placed thing): `advance` files the
 * rectangles written since the last advance by cell; a reader that had
 * caught up with the last advance asks only the cell of its point.
 *
 * `touches(seen, x, y)` answers as `ChangeJournal.touches(seen, [x, y, x, y],
 * kinds)` does; a reader behind the last advance is answered by the journal
 * itself (once: it is caught up after).
 *
 * DO NOT ask the journal per reader per frame: each asked for every entry
 * since its serial - readers x entries a frame, 30 s of a 2 560 m city's
 * growing (`render/agents.ts` `offRoadDeck`, 2026-10-15), quadratic in the
 * city.
 */
export class ChangeSweep {
  private from = -1;
  private now = -1;
  /** Rectangles by cell; null: a change of the whole map (or one too wide to file). */
  private cells: Map<number, ChangeRect[]> | null = new Map();

  constructor(readonly journal: ChangeJournal, private readonly kinds: readonly ChangeKind[]) {}

  /** The serial the readers are brought up to. */
  get serial(): number {
    return this.now;
  }

  /** Reads what was written since the last advance (once a frame). */
  advance(): void {
    const now = this.journal.serialOf(...this.kinds);
    if (now === this.now) return;
    const from = this.now;
    this.from = from;
    this.now = now;
    if (from < 0 || now < from) { this.cells = null; return; }
    const entries = this.journal.since(from, this.kinds);
    if (entries === null) { this.cells = null; return; }
    const cells = new Map<number, ChangeRect[]>();
    for (const entry of entries) {
      if (entry.rects === null) { this.cells = null; return; }
      for (const r of entry.rects) {
        const i0 = Math.floor(r[0] / SWEEP_CELL), i1 = Math.floor(r[2] / SWEEP_CELL);
        const j0 = Math.floor(r[1] / SWEEP_CELL), j1 = Math.floor(r[3] / SWEEP_CELL);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) > SWEEP_MAX_CELLS) { this.cells = null; return; }
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const k = (i + 32768) * 65536 + (j + 32768);
            const list = cells.get(k);
            if (list) list.push(r); else cells.set(k, [r]);
          }
        }
      }
    }
    this.cells = cells;
  }

  /** Whether a change of the kinds after `seen` reaches the point. */
  touches(seen: number, x: number, y: number): boolean {
    if (seen >= this.now) return false;
    if (seen !== this.from) return this.journal.touches(seen, [x, y, x, y], this.kinds);
    if (this.cells === null) return true;
    const list = this.cells.get((Math.floor(x / SWEEP_CELL) + 32768) * 65536 + (Math.floor(y / SWEEP_CELL) + 32768));
    if (!list) return false;
    for (const r of list) if (r[0] <= x && r[2] >= x && r[1] <= y && r[3] >= y) return true;
    return false;
  }
}
