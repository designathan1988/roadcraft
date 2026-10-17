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

  it("refuses a cut past its tile's cap (decision 5.1): nothing filed nor let go; a cut in another tile filed alone", () => {
    // A tile's every clearing cut inside it (the tile from 3,072 m on both axes).
    const doc = new RoadDoc();
    for (let k = 0; k < MAX_TREE_CLEARINGS; k++) doc.cutTrees(3100 + (k % 100) * 9, 3100 + Math.floor(k / 100) * 9, 6);
    const cells = new ClearingCells();
    cells.follow(doc, doc.treeClearings);
    const oldest = doc.treeClearings[0]!;
    const before = cells.work;
    expect(doc.cutTrees(3500, 3500, 10)).toBe(false);
    cells.follow(doc, doc.treeClearings);
    expect(cells.work - before).toBe(0);
    expect(cells.has(oldest.x, oldest.y)).toBe(true);
    expect(doc.treeClearings).toHaveLength(MAX_TREE_CLEARINGS);
    // Another tile: one in, filed alone.
    expect(doc.cutTrees(-4000, -4000, 10)).toBe(true);
    cells.follow(doc, doc.treeClearings);
    expect(cells.work - before).toBe(1);
    expect(cells.has(-4000, -4000)).toBe(true);
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
