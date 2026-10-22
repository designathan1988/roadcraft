import { ForkMap } from '@core/forkMap';
import type { ChangeRect } from './changes';
import { cellWork } from './cells';

/**
 * THINGS THAT ARE POINTS FILED BY THE CELL THEY STAND IN (the street furniture, `RoadDoc.landscapeIn`): each cell's ids, nothing a
 * thing. DO NOT file a point as `CellFiling` files a rectangle - an entry object, a run of its rectangle and cells and a map slot a
 * thing (~180 B a lamp or a bin, two a building of a city, 2026-10-22): where a point stands is read from its record when asked
 * (`at`), and it is taken out of the cell its record stood in (`remove`).
 */

/** A cell's key from its column and row (both within ±32 767), as `cells.ts` keys them. */
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
/** From how many ids a cell's list grows by pushing (kept at its size below, as `CellFiling`'s). */
const GROWN_LIST = 16;

/** Where a filed id stands, from its record. */
export type PointAt<Id> = (id: Id) => { readonly x: number; readonly y: number };

export class PointFiling<Id extends number> {
  /** Each cell's ids, in the order they were filed there. */
  private byCell: Map<number, Id[]> = new Map();

  /** `side`: the side of its cells, world units. */
  constructor(private readonly side: number) {}

  private keyAt(x: number, y: number): number {
    return cellKey(Math.floor(x / this.side), Math.floor(y / this.side));
  }

  /** Files `id` standing at (x, y). */
  file(id: Id, x: number, y: number): void {
    // A point of NaN stands in no cell (as `CellFiling` files a rectangle of NaN in none).
    if (!(Number.isFinite(x) && Number.isFinite(y))) return;
    cellWork.filed++;
    const key = this.keyAt(x, y);
    const list = this.cellToWrite(key);
    if (!list) this.byCell.set(key, [id]);
    else if (list.length >= GROWN_LIST) list.push(id);
    else {
      const next = new Array<Id>(list.length + 1);
      for (let i = 0; i < list.length; i++) next[i] = list[i]!;
      next[list.length] = id;
      this.byCell.set(key, next);
    }
  }

  /** Takes `id`, filed at (x, y), out (nothing when it is not filed there). */
  remove(id: Id, x: number, y: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y))) return;
    const key = this.keyAt(x, y);
    const list = this.cellToWrite(key);
    if (!list) return;
    const at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.byCell.delete(key);
  }

  /** Every id taken out. */
  clear(): void {
    this.byCell = new Map();
  }

  /** The ids standing in `rect` (touching counts), each once, in increasing order (`CellFiling.idsMeeting`). */
  idsMeeting(rect: ChangeRect, at: PointAt<Id>): Id[] {
    const out: Id[] = [];
    this.collect(rect, at, out);
    return out.length > 1 ? out.sort((a, b) => a - b) : out;
  }

  /** The ids standing in any of `rects`, each once, in increasing order (`CellFiling.idsMeetingAny`). */
  idsMeetingAny(rects: readonly ChangeRect[], at: PointAt<Id>): Id[] {
    if (rects.length === 1) return this.idsMeeting(rects[0]!, at);
    const out = new Set<Id>();
    const one: Id[] = [];
    for (const rect of rects) {
      one.length = 0;
      this.collect(rect, at, one);
      for (const id of one) out.add(id);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** The ids of the cells over `rect` standing in it (a point stands in one cell: each id once). */
  private collect(rect: ChangeRect, at: PointAt<Id>, out: Id[]): void {
    const side = this.side;
    const cx0 = Math.floor(rect[0] / side), cx1 = Math.floor(rect[2] / side);
    const cy0 = Math.floor(rect[1] / side), cy1 = Math.floor(rect[3] / side);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        cellWork.cellsRead++;
        const list = this.byCell.get(cellKey(cx, cy));
        if (!list) continue;
        for (const id of list) {
          const p = at(id);
          if (p.x >= rect[0] && p.x <= rect[2] && p.y >= rect[1] && p.y <= rect[3]) out.push(id);
        }
      }
    }
  }

  /** A working copy over `base` that writes only the cells it files in (`CellFiling.over`). */
  static over<Id extends number>(base: PointFiling<Id>): PointFiling<Id> {
    const fork = new PointFiling<Id>(base.side);
    fork.byCell = new ForkMap(base.byCell);
    return fork;
  }

  /** A cell's list to change: in a working copy, the one below copied first. */
  private cellToWrite(key: number): Id[] | undefined {
    return this.byCell instanceof ForkMap ? this.byCell.writable(key, (list) => list.slice()) : this.byCell.get(key);
  }
}
