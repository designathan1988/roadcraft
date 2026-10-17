import { m } from '@world/units';
import type { VehicleFrames } from '../pose';

/** THE PAGE'S VEHICLES BY PLACE: a grid of 64 m cells (the world grid's sub-cell) the client files each view in as it decodes it */

/** A box on the ground, world x and y (three's -z), ends included. */
export interface GroundBox { x0: number; y0: number; x1: number; y1: number }

/** The side of a cell. */
const FLEET_CELL = m(64);

/** Column and row each shifted to a positive 21-bit range, one number per cell (exact in a double). */
const SHIFT = 1 << 20;
const keyOf = (cx: number, cy: number): number => (cx + SHIFT) * (2 * SHIFT) + (cy + SHIFT);

/** A cell of the grid: its key, column and row, its items, and its version (moved, from one serial for the whole grid, each time an item comes, goes or changes in it: a cell let go and made again never shows an old version). */
export interface FleetCell<T> { readonly key: number; readonly cx: number; readonly cy: number; readonly items: T[]; version: number }
type Cell<T> = FleetCell<T>;
interface Slot<T> { cell: Cell<T>; index: number }

/** Each item filed by where it stands now (`frames.x`, `frames.y`); refiled only when it changes cell. */
export class FleetGrid<T extends { readonly frames: VehicleFrames }> {
  private readonly cells = new Map<number, Cell<T>>();
  private readonly slots = new Map<T, Slot<T>>();

  /** The serial the cells' versions are drawn from. */
  private serial = 0;

  get size(): number { return this.slots.size; }

  /** The item filed in the cell of its current pose (taken out where that pose is not a number); its cell's version moves (it came, or it changed). */
  place(item: T): void {
    const x = item.frames.x, y = item.frames.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { this.remove(item); return; }
    const cx = Math.floor(x / FLEET_CELL), cy = Math.floor(y / FLEET_CELL);
    const slot = this.slots.get(item);
    if (slot) {
      if (slot.cell.cx === cx && slot.cell.cy === cy) { slot.cell.version = ++this.serial; return; }
      this.unfile(slot);
      slot.cell = this.cellAt(cx, cy);
      slot.index = slot.cell.items.push(item) - 1;
      slot.cell.version = ++this.serial;
      return;
    }
    const cell = this.cellAt(cx, cy);
    this.slots.set(item, { cell, index: cell.items.push(item) - 1 });
    cell.version = ++this.serial;
  }

  /** An item changed where it is filed (its pose within its cell, its look): its cell's version moves. */
  touch(item: T): void {
    const slot = this.slots.get(item);
    if (slot) slot.cell.version = ++this.serial;
  }

  remove(item: T): void {
    const slot = this.slots.get(item);
    if (!slot) return;
    this.unfile(slot);
    this.slots.delete(item);
  }

  /** The filled cells the box reaches, appended to `out` (each with its items and version: a reader keeps what it made of a cell while its version stands). */
  cellsNear(x0: number, y0: number, x1: number, y1: number, out: FleetCell<T>[]): FleetCell<T>[] {
    if (!(x0 <= x1 && y0 <= y1)) return out;
    const cx0 = Math.floor(x0 / FLEET_CELL), cy0 = Math.floor(y0 / FLEET_CELL);
    const cx1 = Math.floor(x1 / FLEET_CELL), cy1 = Math.floor(y1 / FLEET_CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= this.cells.size) {
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(keyOf(cx, cy));
        if (cell) out.push(cell);
      }
      return out;
    }
    for (const cell of this.cells.values()) if (cell.cx >= cx0 && cell.cx <= cx1 && cell.cy >= cy0 && cell.cy <= cy1) out.push(cell);
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.slots.clear();
  }

  /** The items whose current pose stands in the box, appended to `out`: the cells the box covers, or the filled cells when they are fewer. */
  near(x0: number, y0: number, x1: number, y1: number, out: T[]): T[] {
    if (!(x0 <= x1 && y0 <= y1)) return out;
    const cx0 = Math.floor(x0 / FLEET_CELL), cy0 = Math.floor(y0 / FLEET_CELL);
    const cx1 = Math.floor(x1 / FLEET_CELL), cy1 = Math.floor(y1 / FLEET_CELL);
    const span = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (span <= this.cells.size) {
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(keyOf(cx, cy));
        if (cell) collect(cell.items, x0, y0, x1, y1, out);
      }
      return out;
    }
    for (const cell of this.cells.values()) {
      if (cell.cx >= cx0 && cell.cx <= cx1 && cell.cy >= cy0 && cell.cy <= cy1) collect(cell.items, x0, y0, x1, y1, out);
    }
    return out;
  }

  private cellAt(cx: number, cy: number): Cell<T> {
    const key = keyOf(cx, cy);
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = { key, cx, cy, items: [], version: ++this.serial });
    return cell;
  }

  /** Out of its cell: the cell's last item takes its place; an emptied cell let go. */
  private unfile(slot: Slot<T>): void {
    slot.cell.version = ++this.serial;
    const items = slot.cell.items;
    const last = items.pop()!;
    if (slot.index < items.length) {
      items[slot.index] = last;
      this.slots.get(last)!.index = slot.index;
    }
    if (items.length === 0) this.cells.delete(slot.cell.key);
  }
}

function collect<T extends { readonly frames: VehicleFrames }>(items: readonly T[], x0: number, y0: number, x1: number, y1: number, out: T[]): void {
  for (const item of items) {
    const x = item.frames.x, y = item.frames.y;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(item);
  }
}
