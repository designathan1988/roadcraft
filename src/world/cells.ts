import type { ChangeRect } from './changes';
import { m } from './units';
import { ForkMap } from '@core/forkMap';
import { uniqueCounter } from '@core/identityMemo';

/** THE WORLD'S CELLS: one fixed grid over the plane the map is laid on, the partition an edit's cost is measured in */

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

/** The clock every filing's cell versions are read from */
const nextVersion = uniqueCounter();

/** The work a filing did: things filed and cells visited. A count for the performance budgets (`core/perfBudget.ts`). */
export const cellWork = { filed: 0, cellsRead: 0 };

/** Things (by id) filed in the cells their bounds reach, each with the object it was filed for */
export class CellFiling<Id extends number, T extends object> {
  /** `side`: the side of its cells, world units - the world's cell by default */
  constructor(private readonly side = CELL) {}

  private entries: Map<Id, { readonly item: T; readonly rect: ChangeRect; readonly cells: readonly number[] }> = new Map();
  private byCell: Map<number, Set<Id>> = new Map();
  private versions: Map<number, number> = new Map();
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
      let set = this.cellToWrite(key);
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

  /** The rectangle `id` is filed over, or undefined. */
  rectOf(id: Id): ChangeRect | undefined {
    return this.entries.get(id)?.rect;
  }

  /** The ids filed (any order). */
  ids(): IterableIterator<Id> {
    return this.entries.keys();
  }

  /** The ids whose bounds meet `rect`, each once, in increasing order */
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

  /** DO NOT ask `idsMeeting` rectangle by rectangle for a change of many */
  idsMeetingAny(rects: readonly ChangeRect[]): Id[] {
    if (rects.length === 1) return this.idsMeeting(rects[0]!);
    const over = new Map<number, ChangeRect[]>();
    for (const rect of rects) {
      forCellsOver(rect, (key) => {
        const list = over.get(key);
        if (list) list.push(rect); else over.set(key, [rect]);
      }, this.side);
    }
    const out = new Set<Id>();
    for (const [key, list] of over) {
      cellWork.cellsRead++;
      const set = this.byCell.get(key);
      if (!set) continue;
      for (const id of set) {
        if (out.has(id)) continue;
        const box = this.entries.get(id)!.rect;
        for (const rect of list) if (rectsMeet(box, rect)) { out.add(id); break; }
      }
    }
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

  /** DO NOT copy every cell for an edit (`copyFrom` twice per road drawn): a working copy over `base` that writes only what it files */
  static over<Id extends number, T extends object>(base: CellFiling<Id, T>): CellFiling<Id, T> {
    const fork = new CellFiling<Id, T>(base.side);
    fork.entries = new ForkMap(base.entries);
    fork.byCell = new ForkMap(base.byCell);
    fork.versions = new ForkMap(base.versions);
    fork.epoch = base.epoch;
    return fork;
  }

  /** A working copy's changes (`over`) written into the filing it was made over: what it filed, nothing else. */
  takeBack(fork: CellFiling<Id, T>): void {
    if (!(fork.entries instanceof ForkMap)) throw new Error('CellFiling.takeBack: not a working copy');
    fork.entries.applyTo(this.entries);
    (fork.byCell as ForkMap<number, Set<Id>>).applyTo(this.byCell);
    (fork.versions as ForkMap<number, number>).applyTo(this.versions);
    this.epoch = fork.epoch;
  }

  /** A cell's set to change: in a working copy, the one below copied first (a cell it files in, not the map). */
  private cellToWrite(key: number): Set<Id> | undefined {
    return this.byCell instanceof ForkMap ? this.byCell.writable(key, (set) => new Set(set)) : this.byCell.get(key);
  }

  private unfile(id: Id, cells: readonly number[]): void {
    for (const key of cells) {
      const set = this.cellToWrite(key);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.byCell.delete(key);
      this.bump(key);
    }
  }

  private bump(key: number): void {
    const version = nextVersion();
    this.versions.set(key, version);
    // From the same clock: an epoch names one change too, never another filing's
    this.epoch = version;
  }
}
