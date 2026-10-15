import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { ChangeRect } from '@world/changes';
import { CellFiling, cellWork } from '@world/cells';

/**
 * THE THINGS A CHANGE OF MANY RECTANGLES REACHES, IN ONE LOOK
 * (`CellFiling.idsMeetingAny`): the same ids as asking each rectangle on its
 * own and joining them, in increasing order, each cell read once. Asked
 * rectangle by rectangle, the street furniture read the cells an entry's
 * overlapping blocks shared again for each block (2026-10-15).
 */
describe('a filing asked for several rectangles at once', () => {
  let seed = 11;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const box = (x: number, y: number, w: number, h: number): ChangeRect => [x, y, x + w, y + h];

  it('answers what each rectangle on its own answers, joined and in order', () => {
    const filing = new CellFiling<number, object>(100);
    for (let id = 1; id <= 2_000; id++) {
      const x = rand() * 5_000, y = rand() * 5_000;
      filing.file(id, {}, box(x, y, rand() * 40, rand() * 40));
    }
    for (let round = 0; round < 30; round++) {
      const rects: ChangeRect[] = [];
      const n = 1 + Math.floor(rand() * 12);
      for (let k = 0; k < n; k++) rects.push(box(rand() * 5_000, rand() * 5_000, rand() * 600, rand() * 600));
      const each = new Set<number>();
      for (const r of rects) for (const id of filing.idsMeeting(r)) each.add(id);
      expect(filing.idsMeetingAny(rects)).toEqual([...each].sort((a, b) => a - b));
    }
  });

  it('reads each cell once for rectangles that overlap', () => {
    const filing = new CellFiling<number, object>(100);
    filing.file(1, {}, box(50, 50, 10, 10));
    const rects: ChangeRect[] = Array.from({ length: 20 }, (_, k) => box(k, k, 400, 400));
    const before = cellWork.cellsRead;
    expect(filing.idsMeetingAny(rects)).toEqual([1]);
    // 20 rectangles over the same 5 x 5 cells (and a few more): read once each, not 20 times.
    expect(cellWork.cellsRead - before).toBeLessThanOrEqual(6 * 6);
  });

  it('is what the street furniture asks a change with', () => {
    const source = readFileSync('src/render/streetFurnitureLayer.ts', 'utf8');
    expect(source).toMatch(/landscapeInAny\(areas\)/);
    expect(source).toMatch(/idsMeetingAny\(areas\)/);
    expect(source).not.toMatch(/landscapeIn\(area\)/);
  });

  it('is how every product of the diary looks round a change of many rectangles', () => {
    // DO NOT look rectangle by rectangle (`for (const r of change.rects) ... idsMeeting(r)`).
    for (const path of ['src/render/barriers.ts', 'src/render/signLayer.ts', 'src/render/transit.ts', 'src/world/networkBuild.ts', 'src/world/roads/footwayRise.ts']) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).toMatch(/idsMeetingAny\(/);
      expect(text, path).not.toMatch(/for \(const (r|rect) of (change\.|entry\.)?rects\)[^\n]*idsMeeting\(/);
    }
  });
});
