import type { ChangeRect } from '@world/changes';
import { CandidateKeep, KEEP_CELL, keepCellKey, keepCellOf } from './candidateKeep';

/** DO NOT hold a kind's places as one list again: a change in one cell made the whole list, and every place's test, again */

/** The keep cell holding a point. */
export const keepCellAt = (x: number, y: number): number => keepCellKey(Math.floor(x / KEEP_CELL), Math.floor(y / KEEP_CELL));

/** The rectangle a keep cell covers. */
export function keepCellRect(key: number): ChangeRect {
  const [i, j] = keepCellOf(key);
  return [i * KEEP_CELL, j * KEEP_CELL, (i + 1) * KEEP_CELL, (j + 1) * KEEP_CELL];
}

/** Each keep cell a rectangle grown by `pad` reaches, into `out`. */
export function keepCellsOver(rect: ChangeRect, pad: number, out: Set<number>): Set<number> {
  const i0 = Math.floor((rect[0] - pad) / KEEP_CELL), i1 = Math.floor((rect[2] + pad) / KEEP_CELL);
  const j0 = Math.floor((rect[1] - pad) / KEEP_CELL), j1 = Math.floor((rect[3] + pad) / KEEP_CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.add(keepCellKey(i, j));
  return out;
}

/** The places of a kind kept cell by cell: a `CandidateKeep` per keep cell, filled again on its own */
export class CellKeeps<C extends { readonly x: number; readonly y: number }> {
  private readonly keeps = new Map<number, CandidateKeep<C>>();
  /** The cells whose places, or their standing, changed since the last `takeChangedCells`; null: every cell. */
  private changed: Set<number> | null = null;
  /** Places tested since the keeps were made: the work, for the specs. */
  tested = 0;
  private readonly counted = (c: C): number | null => {
    this.tested++;
    return this.test(c);
  };

  /** `test`: the ground under a place where it may stand, null where it may not (`CandidateKeep`). */
  constructor(private readonly test: (c: C) => number | null) {}

  /** Cells holding places. */
  get size(): number {
    return this.keeps.size;
  }

  /** The places of cell `key` from now on (each standing in it), tested; an empty list lets the cell go. */
  fill(key: number, list: readonly C[], same?: (a: C, b: C) => boolean): void {
    const was = this.keeps.get(key);
    if (!list.length) {
      if (was) { this.keeps.delete(key); this.changed?.add(key); }
      return;
    }
    // The same places as before (a dab that changed nothing here): kept as they stand, not tested nor drawn again.
    if (was && same && was.list.length === list.length && was.list.every((c, k) => same(c, list[k]!))) return;
    const keep = new CandidateKeep(list, this.counted);
    keep.refresh(null, 0);
    keep.takeChangedCells();
    this.keeps.set(key, keep);
    this.changed?.add(key);
  }

  /** @rebuild Every cell let go (the map opened, or the diary cannot say what changed): the next look draws every cell. */
  clear(): void {
    this.keeps.clear();
    this.changed = null;
  }

  /** The places a change reached tested again, in the cells the change reaches only (`CandidateKeep.refresh`). */
  refresh(rects: readonly ChangeRect[], pad: number): void {
    // Each cell is asked only of the rectangles that reach it, cut to it: a wide change reads each cell once.
    const reaching = new Map<number, ChangeRect[]>();
    const cells = new Set<number>();
    for (const r of rects) {
      cells.clear();
      for (const key of keepCellsOver(r, pad, cells)) {
        if (!this.keeps.has(key)) continue;
        const [x0, y0, x1, y1] = keepCellRect(key);
        const cut: ChangeRect = [Math.max(r[0], x0 - pad), Math.max(r[1], y0 - pad), Math.min(r[2], x1 + pad), Math.min(r[3], y1 + pad)];
        const list = reaching.get(key);
        if (list) list.push(cut); else reaching.set(key, [cut]);
      }
    }
    for (const [key, cut] of reaching) {
      if (this.keeps.get(key)!.refresh(cut, pad)) this.changed?.add(key);
    }
  }

  /** @rebuild Every place tested again: a change the diary cannot place. */
  refreshAll(): void {
    for (const [key, keep] of this.keeps) if (keep.refresh(null, 0)) this.changed?.add(key);
  }

  /** The cells whose places changed since the last call, and the call itself the new start; null: every cell. */
  takeChangedCells(): Set<number> | null {
    const out = this.changed;
    this.changed = new Set();
    return out;
  }

  /** Every cell with a place in it. */
  cellKeys(): IterableIterator<number> {
    return this.keeps.keys();
  }

  /** The places standing in a cell, and the ground under each. */
  standingIn(key: number): { readonly c: C; readonly z: number }[] {
    return this.keeps.get(key)?.standingIn(key) ?? [];
  }
}
