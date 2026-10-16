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

interface Cell<T> { readonly key: number; readonly cx: number; readonly cy: number; readonly items: T[] }
interface Slot<T> { cell: Cell<T>; index: number }

/** Each item filed by where it stands now (`frames.x`, `frames.y`); refiled only when it changes cell. */
export class FleetGrid<T extends { readonly frames: VehicleFrames }> {
  private readonly cells = new Map<number, Cell<T>>();
  private readonly slots = new Map<T, Slot<T>>();

  get size(): number { return this.slots.size; }

  /** The item filed in the cell of its current pose (taken out where that pose is not a number). */
  place(item: T): void {
    const x = item.frames.x, y = item.frames.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { this.remove(item); return; }
    const cx = Math.floor(x / FLEET_CELL), cy = Math.floor(y / FLEET_CELL);
    const slot = this.slots.get(item);
    if (slot) {
      if (slot.cell.cx === cx && slot.cell.cy === cy) return;
      this.unfile(slot);
      slot.cell = this.cellAt(cx, cy);
      slot.index = slot.cell.items.push(item) - 1;
      return;
    }
    const cell = this.cellAt(cx, cy);
    this.slots.set(item, { cell, index: cell.items.push(item) - 1 });
  }

  remove(item: T): void {
    const slot = this.slots.get(item);
    if (!slot) return;
    this.unfile(slot);
    this.slots.delete(item);
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
    if (!cell) this.cells.set(key, cell = { key, cx, cy, items: [] });
    return cell;
  }

  /** Out of its cell: the cell's last item takes its place; an emptied cell let go. */
  private unfile(slot: Slot<T>): void {
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
