import { describe, expect, it } from 'vitest';

import { ClearingCells } from '@render/clearingCells';
import { RoadDoc } from '@world/doc';
import { MAX_TREE_CLEARINGS } from '@world/trees';

/** A document with `n` clearings cut along a row, and the filing brought up to it. */
function cut(n: number): { doc: RoadDoc; cells: ClearingCells } {
  const doc = new RoadDoc();
  for (let k = 0; k < n; k++) doc.cutTrees(-4000 + (k % 400) * 20, -4000 + Math.floor(k / 400) * 20, 6);
  const cells = new ClearingCells();
  cells.follow(doc, doc.treeClearings);
  return { doc, cells };
}

/** THE CLEARINGS BY PLACE (`clearingCells.ts`): one cut files one clearing, never the map's again */
describe('the clearings by place', () => {
  it('files the clearing just cut, whatever the number cut before', () => {
    const work = (n: number): number => {
      const { doc, cells } = cut(n);
      const before = cells.work;
      doc.cutTrees(3000, 3000, 10);
      cells.follow(doc, doc.treeClearings);
      expect(cells.has(3005, 3002)).toBe(true);
      return cells.work - before;
    };
    expect(work(5)).toBe(1);
    expect(work(3_000)).toBe(1);
  });

  it('lets the oldest go at the cap, one in and one out', () => {
    const { doc, cells } = cut(MAX_TREE_CLEARINGS);
    const oldest = doc.treeClearings[0]!;
    expect(cells.has(oldest.x, oldest.y)).toBe(true);
    const before = cells.work;
    doc.cutTrees(4000, 4000, 10);
    cells.follow(doc, doc.treeClearings);
    expect(cells.work - before).toBe(2);
    expect(cells.has(oldest.x, oldest.y)).toBe(false);
    expect(cells.has(4000, 4000)).toBe(true);
  });

  it('files a list replaced whole again, and a document of its own afresh', () => {
    const { doc, cells } = cut(10);
    doc.clearTrees();
    cells.follow(doc, doc.treeClearings);
    expect(cells.has(-4000, -4000)).toBe(false);
    const other = new RoadDoc();
    other.cutTrees(100, 100, 10);
    cells.follow(other, other.treeClearings);
    expect(cells.has(100, 100)).toBe(true);
  });
});
