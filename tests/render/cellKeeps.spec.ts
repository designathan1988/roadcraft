import { describe, expect, it } from 'vitest';

import { CellKeeps, keepCellAt, keepCellRect, keepCellsOver } from '@render/cellKeeps';
import { KEEP_CELL } from '@render/candidateKeep';

interface Place { readonly x: number; readonly y: number }

/** `cells` cells along a row, `each` places in each, all standing on the ground at 0. */
function town(cells: number, each: number): { keeps: CellKeeps<Place>; lists: Map<number, Place[]> } {
  const keeps = new CellKeeps<Place>(() => 0);
  const lists = new Map<number, Place[]>();
  for (let c = 0; c < cells; c++) {
    const list: Place[] = [];
    for (let k = 0; k < each; k++) list.push({ x: c * KEEP_CELL + 1 + (k % 8) * 7, y: 1 + Math.floor(k / 8) * 7 });
    const key = keepCellAt(list[0]!.x, list[0]!.y);
    lists.set(key, list);
    keeps.fill(key, list);
  }
  return { keeps, lists };
}

/** THE PLACES KEPT CELL BY CELL (`cellKeeps.ts`): an edit costs its own cells, never the map's */
describe('places kept cell by cell', () => {
  it('files a place in the cell its own point falls in', () => {
    for (const [x, y] of [[0, 0], [63.9, 0.1], [64, 64], [-0.1, -64.1], [1000.5, -333.3]] as const) {
      const r = keepCellRect(keepCellAt(x, y));
      expect(x >= r[0] && x < r[2] && y >= r[1] && y < r[3]).toBe(true);
    }
  });

  it('tests again only the places of the cell filled again, whatever the size of the map', () => {
    const work = (cells: number): number => {
      const { keeps, lists } = town(cells, 40);
      keeps.takeChangedCells();
      const before = keeps.tested;
      const key = [...lists.keys()][Math.floor(cells / 2)]!;
      keeps.fill(key, [...lists.get(key)!, { x: keepCellRect(key)[0] + 30, y: 30 }]);
      expect(keeps.takeChangedCells()).toEqual(new Set([key]));
      return keeps.tested - before;
    };
    expect(work(10)).toBe(41);
    expect(work(2_000)).toBe(41);
  });

  it('keeps a cell filled with the same places as it stands, untested and not drawn again', () => {
    const { keeps, lists } = town(5, 10);
    keeps.takeChangedCells();
    const before = keeps.tested;
    const [key, list] = [...lists][2]!;
    keeps.fill(key, [...list], (a, b) => a === b);
    expect(keeps.tested).toBe(before);
    expect(keeps.takeChangedCells()!.size).toBe(0);
  });

  it('lets a cell go when it is filled with nothing, and says so', () => {
    const { keeps, lists } = town(3, 4);
    keeps.takeChangedCells();
    const key = [...lists.keys()][1]!;
    keeps.fill(key, []);
    expect(keeps.size).toBe(2);
    expect(keeps.standingIn(key)).toEqual([]);
    expect(keeps.takeChangedCells()).toEqual(new Set([key]));
  });

  it('asks a change only of the cells it reaches, each place once', () => {
    const work = (cells: number): number => {
      const { keeps } = town(cells, 16);
      keeps.takeChangedCells();
      const before = keeps.tested;
      // A change over the first two cells and a few metres of the third.
      keeps.refresh([[0, 0, 2 * KEEP_CELL + 3, 10]], 0);
      return keeps.tested - before;
    };
    const small = work(4);
    expect(work(3_000)).toBe(small);
    // The places within the change's box only: x within 0..131 and y within 0..10.
    expect(small).toBeLessThanOrEqual(3 * 8 * 2);
  });

  it('answers every cell after it is cleared, and its places from the next fill', () => {
    const { keeps } = town(3, 4);
    keeps.takeChangedCells();
    keeps.clear();
    keeps.fill(keepCellAt(1, 1), [{ x: 1, y: 1 }]);
    expect(keeps.takeChangedCells()).toBeNull();
    expect(keeps.standingIn(keepCellAt(1, 1))).toEqual([{ c: { x: 1, y: 1 }, z: 0 }]);
  });

  it('lists the cells a rectangle and its margin reach', () => {
    const cells = keepCellsOver([10, 10, 20, 20], KEEP_CELL, new Set());
    expect(cells.size).toBe(9);
    expect(cells.has(keepCellAt(15, 15))).toBe(true);
  });
});
