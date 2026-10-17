import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { cellWork } from '@world/cells';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/** THE CROSSINGS A CHANGE MAY HAVE MOVED, FOUND IN ONE LOOK (plan B7): the rectangles of a change read together, each cell they share read once */

describe("the network's kept crossings", () => {
  it('are let go for every rectangle of a change read in one look, not a look a rectangle', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: m(200), y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc);
    net.rebuild();
    // Three rectangles over the same cells (a road's box, its ends'): its cells are read once.
    const rect: ChangeRect = [m(-10), m(-10), m(210), m(10)];
    const forget = (rects: ChangeRect[]): number => {
      const before = cellWork.cellsRead;
      (net as unknown as { forgetCrossings(delta: unknown): void }).forgetCrossings({ segments: [], nodes: [], rects });
      return cellWork.cellsRead - before;
    };
    const one = forget([rect]);
    expect(one).toBeGreaterThan(0);
    expect(forget([rect, rect, rect])).toBe(one);
  });
});
