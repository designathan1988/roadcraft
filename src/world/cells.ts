import type { ChangeRect } from './changes';
import { m } from './units';
import { uniqueCounter } from '@core/identityMemo';

/**
 * THE WORLD'S CELLS: one fixed grid over the plane the map is laid on, the
 * partition an edit's cost is
 * measured in (docs/source/relatorio-desempenho-mapas-enormes-2026-10-11.md 6.2).
 *
 * A fixed grid, not a tree: the cheapest structure to keep in step with
 * edits, and a thing is filed in the cells its bounds reach, so a question
 * about a place reads only the cells round it (Nystrom, "Spatial Partition";
 * Unreal World Partition's runtime grid, 256 m cells). Whatever is derived
 * from what a cell holds is keyed by the cell's version and made again only
 * when that moves: an edit pays for the cells it reaches, never for the map.
 *
 * Pure: no three, no DOM.
 */

/** The side of a cell, world units (Unreal's default runtime grid cell). */
export const CELL = m(256);

/** A cell's key from its column and row (both within ±32 767). */
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
const cellColumn = (key: number): number => Math.floor(key / 65536) - 32768;
const cellRow = (key: number): number => (key % 65536) - 32768;

/** The rectangle a cell covers. */
export function cellRect(key: number): ChangeRect {
  const x0 = cellColumn(key) * CELL, y0 = cellRow(key) * CELL;
  return [x0, y0, x0 + CELL, y0 + CELL];
}

/** The key of the cell holding a point. */
export const cellAt = (x: number, y: number): number => cellKey(Math.floor(x / CELL), Math.floor(y / CELL));

/** Calls `visit` with every cell (of side `side`) a rectangle reaches. */
function forCellsOver(rect: ChangeRect, visit: (key: number) => void, side = CELL): void {
  const cx0 = Math.floor(rect[0] / side), cx1 = Math.floor(rect[2] / side);
  const cy0 = Math.floor(rect[1] / side), cy1 = Math.floor(rect[3] / side);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) visit(cellKey(cx, cy));
}

/** A rectangle grown by `pad` on every side. */
export const grow = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];

/** Whether two rectangles overlap (touching counts). */
const rectsMeet = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * The clock every filing's cell versions are read from: a version names one
 * change of one cell of one filing, never another's. A stamp (`stamp`) made
 * against one filing then never matches another's cells, nor the same
 * filing's after it took another's (`copyFrom`) or started again: whatever
 * is kept by stamp stays right through `Network.adopt` and a full rebuild.
 */
const nextVersion = uniqueCounter();

/** The work a filing did: things filed and cells visited. A count for the performance budgets (`core/perfBudget.ts`). */
export const cellWork = { filed: 0, cellsRead: 0 };

/**
 * Things (by id) filed in the cells their bounds reach, each with the object
 * it was filed for: filing the same object again is free, a new object (a
 * ribbon built again, a junction solved again) moves it. Every cell has a
 * version that moves whenever something in it comes, goes or changes, so a
 * result made from a set of cells is still good while their versions stand.
 */
export class CellFiling<Id extends number, T extends object> {
  /**
   * `side`: the side of its cells, world units - the world's cell by default;
   * smaller for small things asked about at a point (the street furniture), so
   * a question reads a few of them, not a city block's.
   */
  constructor(private readonly side = CELL) {}

  private readonly entries = new Map<Id, { readonly item: T; readonly rect: ChangeRect; readonly cells: readonly number[] }>();
  private readonly byCell = new Map<number, Set<Id>>();
  private readonly versions = new Map<number, number>();
  /** Moves whenever any cell's version does: the clock's reading at the latest change. */
  epoch = 0;

  get size(): number {
    return this.entries.size;
  }

  /** Files `id` for `item` over `rect`; nothing happens when it is already filed for that same object. */
  file(id: Id, item: T, rect: ChangeRect): void {
    const known = this.entries.get(id);
    if (known && known.item === item) return;
    if (known) this.unfile(id, known.cells);
    cellWork.filed++;
    const cells: number[] = [];
    forCellsOver(rect, (key) => {
      cells.push(key);
      let set = this.byCell.get(key);
      if (!set) this.byCell.set(key, set = new Set());
      set.add(id);
      this.bump(key);
    }, this.side);
    this.entries.set(id, { item, rect, cells });
  }

  /** Takes `id` out (nothing when it is not filed). */
  remove(id: Id): void {
    const known = this.entries.get(id);
    if (!known) return;
    this.unfile(id, known.cells);
    this.entries.delete(id);
  }

  /** Whether `id` is filed for exactly `item`. */
  holds(id: Id, item: T): boolean {
    return this.entries.get(id)?.item === item;
  }

  /** The ids filed (any order). */
  ids(): IterableIterator<Id> {
    return this.entries.keys();
  }

  /**
   * The ids whose bounds meet `rect`, each once, in increasing order (a
   * result made from them does not depend on the order things were filed in).
   */
  idsMeeting(rect: ChangeRect): Id[] {
    const out = new Set<Id>();
    forCellsOver(rect, (key) => {
      cellWork.cellsRead++;
      const set = this.byCell.get(key);
      if (!set) return;
      for (const id of set) {
        if (out.has(id)) continue;
        if (rectsMeet(this.entries.get(id)!.rect, rect)) out.add(id);
      }
    }, this.side);
    return [...out].sort((a, b) => a - b);
  }

  /** The versions of the cells `rect` reaches, as one string: equal strings, nothing filed there moved. */
  stamp(rect: ChangeRect): string {
    let text = '';
    forCellsOver(rect, (key) => { text += `${this.versions.get(key) ?? 0},`; }, this.side);
    return text;
  }

  /** A copy filing the same things (`Network.adopt`). */
  copyFrom(other: CellFiling<Id, T>): void {
    if (other.side !== this.side) throw new Error(`CellFiling: cells of ${other.side} copied into cells of ${this.side}`);
    this.entries.clear();
    this.byCell.clear();
    this.versions.clear();
    for (const [id, entry] of other.entries) this.entries.set(id, entry);
    for (const [key, set] of other.byCell) this.byCell.set(key, new Set(set));
    for (const [key, version] of other.versions) this.versions.set(key, version);
    this.epoch = other.epoch;
  }

  private unfile(id: Id, cells: readonly number[]): void {
    for (const key of cells) {
      const set = this.byCell.get(key);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.byCell.delete(key);
      this.bump(key);
    }
  }

  private bump(key: number): void {
    const version = nextVersion();
    this.versions.set(key, version);
    // From the same clock: an epoch names one change too, never another
    // filing's (`poleLines.ts` keeps its regions by epoch across `adopt`).
    this.epoch = version;
  }
}
