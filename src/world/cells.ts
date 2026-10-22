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


/** The clock every filing's cell versions are read from */
const nextVersion = uniqueCounter();

/** The work a filing did: things filed and cells visited. A count for the performance budgets (`core/perfBudget.ts`). */
export const cellWork = { filed: 0, cellsRead: 0 };

/** What a filing keeps of a thing: the object it was filed for and one run of numbers, its rectangle then the keys of its cells (`RECT`). */
interface Entry<T> {
  readonly item: T;
  /** DO NOT keep the rectangle and the cells as two lists (and a set a cell: ~440 B a thing filed, 2026-10-21): [x0, y0, x1, y1, cell...], laid at its size. */
  readonly data: readonly number[];
}
/** How many numbers of an entry's run are its rectangle. */
const RECT = 4;

/** An entry's rectangle, as `rectOf` hands it out (a new one: the entry keeps numbers). */
const rectIn = (data: readonly number[]): ChangeRect => [data[0]!, data[1]!, data[2]!, data[3]!];

/** Whether an entry's rectangle meets `rect` (touching counts). */
const entryMeets = (d: readonly number[], rect: ChangeRect): boolean => d[0]! <= rect[2] && d[2]! >= rect[0] && d[1]! <= rect[3] && d[3]! >= rect[1];

/** Things (by id) filed in the cells their bounds reach, each with the object it was filed for */
export class CellFiling<Id extends number, T extends object> {
  /** `side`: the side of its cells, world units - the world's cell by default */
  constructor(private readonly side = CELL) {}

  private entries: Map<Id, Entry<T>> = new Map();
  /** Each cell's ids in the order they were filed there (a list, not a set: a few ids a cell, a set's table ~100 B). */
  private byCell: Map<number, Id[]> = new Map();
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
    if (known) this.unfile(id, known.data);
    cellWork.filed++;
    const side = this.side;
    const cx0 = Math.floor(rect[0] / side), cx1 = Math.floor(rect[2] / side);
    const cy0 = Math.floor(rect[1] / side), cy1 = Math.floor(rect[3] / side);
    // No cell for a rectangle turned inside out or of NaN (the walk over it visits none).
    const across = cx1 >= cx0 ? cx1 - cx0 + 1 : 0, down = cy1 >= cy0 ? cy1 - cy0 + 1 : 0;
    const data = new Array<number>(RECT + across * down);
    data[0] = rect[0]; data[1] = rect[1]; data[2] = rect[2]; data[3] = rect[3];
    let k = RECT;
    forCellsOver(rect, (key) => {
      data[k++] = key;
      const list = this.cellToWrite(key);
      if (!list) this.byCell.set(key, [id]);
      else list.push(id);
      this.bump(key);
    }, side);
    this.entries.set(id, { item, data });
  }

  /** Takes `id` out (nothing when it is not filed). */
  remove(id: Id): void {
    const known = this.entries.get(id);
    if (!known) return;
    this.unfile(id, known.data);
    this.entries.delete(id);
  }

  /** Whether `id` is filed for exactly `item`. */
  holds(id: Id, item: T): boolean {
    return this.entries.get(id)?.item === item;
  }

  /** The rectangle `id` is filed over, or undefined. */
  rectOf(id: Id): ChangeRect | undefined {
    const known = this.entries.get(id);
    return known ? rectIn(known.data) : undefined;
  }

  /** The ids filed (any order). */
  ids(): IterableIterator<Id> {
    return this.entries.keys();
  }

  /** The ids whose bounds meet `rect`, each once, in increasing order */
  idsMeeting(rect: ChangeRect): Id[] {
    // One cell (most questions: a point, a building's rectangle): its set holds each id once, no set to make.
    const side = this.side;
    const cx = Math.floor(rect[0] / side), cy = Math.floor(rect[1] / side);
    if (cx === Math.floor(rect[2] / side) && cy === Math.floor(rect[3] / side)) {
      cellWork.cellsRead++;
      const list = this.byCell.get(cellKey(cx, cy));
      if (!list) return [];
      const one: Id[] = [];
      for (const id of list) if (entryMeets(this.entries.get(id)!.data, rect)) one.push(id);
      return one.length > 1 ? one.sort((a, b) => a - b) : one;
    }
    const out = new Set<Id>();
    forCellsOver(rect, (key) => {
      cellWork.cellsRead++;
      const list = this.byCell.get(key);
      if (!list) return;
      for (const id of list) {
        if (out.has(id)) continue;
        if (entryMeets(this.entries.get(id)!.data, rect)) out.add(id);
      }
    }, this.side);
    return [...out].sort((a, b) => a - b);
  }

  /** Whether `test` holds for some id whose bounds hold the point (x, y): its one cell looked at, nothing made (no rectangle, set nor list a point, as `idsMeeting` makes: asked for every vertex of a road surface). */
  someAt(x: number, y: number, test: (id: Id, item: T) => boolean): boolean {
    cellWork.cellsRead++;
    const list = this.byCell.get(cellKey(Math.floor(x / this.side), Math.floor(y / this.side)));
    if (!list) return false;
    for (const id of list) {
      const entry = this.entries.get(id)!, r = entry.data;
      if (r[0]! <= x && r[2]! >= x && r[1]! <= y && r[3]! >= y && test(id, entry.item)) return true;
    }
    return false;
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
      const ids = this.byCell.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (out.has(id)) continue;
        const box = this.entries.get(id)!.data;
        for (const rect of list) if (entryMeets(box, rect)) { out.add(id); break; }
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
    for (const [key, list] of other.byCell) this.byCell.set(key, list.slice());
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
    (fork.byCell as ForkMap<number, Id[]>).applyTo(this.byCell);
    (fork.versions as ForkMap<number, number>).applyTo(this.versions);
    this.epoch = fork.epoch;
  }

  /** A cell's list to change: in a working copy, the one below copied first (a cell it files in, not the map). */
  private cellToWrite(key: number): Id[] | undefined {
    return this.byCell instanceof ForkMap ? this.byCell.writable(key, (list) => list.slice()) : this.byCell.get(key);
  }

  /** `id` taken out of the cells of its entry's run (`data` past `RECT`). */
  private unfile(id: Id, data: readonly number[]): void {
    for (let k = RECT; k < data.length; k++) {
      const key = data[k]!;
      const list = this.cellToWrite(key);
      if (!list) continue;
      // In the order filed (as a set's), the rest kept in theirs.
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      // An emptied cell's version let go with it (DO NOT keep a number for every cell ever filed in: a version reads 0 for a cell holding nothing, as it did before anything came).
      if (list.length === 0) { this.byCell.delete(key); this.versions.delete(key); this.epoch = nextVersion(); } else this.bump(key);
    }
  }

  private bump(key: number): void {
    const version = nextVersion();
    this.versions.set(key, version);
    // From the same clock: an epoch names one change too, never another filing's
    this.epoch = version;
  }
}
