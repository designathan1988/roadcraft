import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { FleetGrid } from '@sim/host/fleetGrid';
import type { VehicleFrames } from '@sim/pose';
import { m } from '@world/units';

/** The page's vehicles by place (`SimClient.vehiclesIn`): a box asked of the grid gives what a walk of every vehicle gives */

interface Item { readonly id: number; readonly frames: VehicleFrames }

const itemAt = (id: number, x: number, y: number): Item =>
  ({ id, frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false } });

const ids = (items: readonly Item[]): number[] => items.map((i) => i.id).sort((a, b) => a - b);

/** The walk the grid replaces: every item whose pose stands in the box. */
const scan = (items: Iterable<Item>, x0: number, y0: number, x1: number, y1: number): Item[] =>
  [...items].filter((i) => i.frames.x >= x0 && i.frames.x <= x1 && i.frames.y >= y0 && i.frames.y <= y1);

describe('the fleet grid', () => {
  it('answers a box as a walk of the whole fleet does, through moves, comings and goings', () => {
    const rng = new Rng(7);
    const grid = new FleetGrid<Item>();
    const live = new Map<number, Item>();
    const spread = m(3000);
    let next = 1;
    for (let round = 0; round < 40; round++) {
      // Some come, some go, most move a little (a tick's step), a few jump far.
      for (let k = 0; k < 60; k++) {
        const item = itemAt(next++, rng.range(-spread, spread), rng.range(-spread, spread));
        live.set(item.id, item);
        grid.place(item);
      }
      for (const item of [...live.values()]) {
        const roll = rng.float();
        if (roll < 0.1) { live.delete(item.id); grid.remove(item); continue; }
        const f = item.frames;
        f.bx = f.x; f.by = f.y;
        if (roll < 0.15) { f.x = rng.range(-spread, spread); f.y = rng.range(-spread, spread); }
        else { f.x += rng.range(-m(2), m(2)); f.y += rng.range(-m(2), m(2)); }
        grid.place(item);
      }
      expect(grid.size).toBe(live.size);
      for (let q = 0; q < 30; q++) {
        // Small boxes (the cells they cover walked) and wide ones (the filled cells walked).
        const half = q % 3 === 0 ? rng.range(m(1), m(30)) : q % 3 === 1 ? rng.range(m(30), m(600)) : rng.range(m(2000), m(9000));
        const cx = rng.range(-spread, spread), cy = rng.range(-spread, spread);
        const x0 = cx - half, y0 = cy - half * rng.range(0.2, 1.5), x1 = cx + half, y1 = cy + half;
        expect(ids(grid.near(x0, y0, x1, y1, []))).toEqual(ids(scan(live.values(), x0, y0, x1, y1)));
      }
      // A box turned over holds nothing.
      expect(grid.near(m(10), 0, -m(10), 0, [])).toEqual([]);
    }
  });

  it('keeps a cell border and a pose that is not a number straight', () => {
    const grid = new FleetGrid<Item>();
    const on = itemAt(1, m(64), m(-64)), lost = itemAt(2, Number.NaN, 0);
    grid.place(on); grid.place(lost);
    expect(grid.size).toBe(1);
    expect(ids(grid.near(m(64), m(-64), m(64), m(-64), []))).toEqual([1]);
    expect(ids(grid.near(m(63.9), m(-64.1), m(64.1), m(-63.9), []))).toEqual([1]);
    expect(grid.near(-Infinity, -Infinity, Infinity, Infinity, []).length).toBe(1);
    grid.clear();
    expect(grid.near(-Infinity, -Infinity, Infinity, Infinity, [])).toEqual([]);
  });

  it("moves a cell's version when an item comes, goes or changes in it, and only that cell's", () => {
    const grid = new FleetGrid<Item>();
    const a = itemAt(1, m(10), m(10)), b = itemAt(2, m(200), m(10)), c = itemAt(3, m(20), m(20));
    for (const item of [a, b, c]) grid.place(item);
    const versions = (): Map<number, number> => new Map(grid.cellsNear(-m(1000), -m(1000), m(1000), m(1000), []).map((cell) => [cell.key, cell.version]));
    const cellOf = (item: Item): number => grid.cellsNear(item.frames.x, item.frames.y, item.frames.x, item.frames.y, [])[0]!.key;
    const before = versions();
    expect(before.size).toBe(2);
    // Changed in place: its cell alone.
    a.frames.x += m(1);
    grid.touch(a);
    let now = versions();
    expect(now.get(cellOf(a))).toBeGreaterThan(before.get(cellOf(a))!);
    expect(now.get(cellOf(b))).toBe(before.get(cellOf(b)));
    // Gone: its cell moves; a cell emptied and filled again never shows a version of before.
    const was = versions();
    grid.remove(b);
    expect(versions().has(cellOf(a))).toBe(true);
    const bKey = was.get([...was.keys()].find((k) => k !== cellOf(a))!)!;
    grid.place(b);
    now = versions();
    expect(now.get(cellOf(b))).toBeGreaterThan(bKey);
    // The cells a box reaches, with their items.
    const near = grid.cellsNear(0, 0, m(50), m(50), []);
    expect(near.flatMap((cell) => cell.items.map((i) => i.id)).sort()).toEqual([1, 3]);
  });
});
