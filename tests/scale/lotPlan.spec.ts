import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { applyLots, lotPlanWork, planLots } from '@world/lots';
import { m } from '@world/units';

/** ONE ROAD MORE COSTS THE LOTS' PLAN THE SAME IN A SMALL TOWN AND A LARGE ONE (`edit.spec.ts`'s rule, for the lots) */
const BLOCK = 120;

function grid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

/** The plan's work for one road drawn in open land, the same place for every town, once the town's lots are cut. */
function editWork(n: number): { tiles: number; cells: number; planned: number; lots: number } {
  const doc = grid(n);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  planLots(doc, net);
  const before = { ...lotPlanWork };
  // Far from every town measured: more than a block's bound away (`MAX_BLOCK`).
  const a = doc.addNode({ x: m(4000), y: m(0) });
  const b = doc.addNode({ x: m(4080), y: m(10) });
  doc.addSegment(a.id, b.id, 1);
  net.rebuild();
  const plan = planLots(doc, net);
  return {
    tiles: lotPlanWork.tiles - before.tiles,
    cells: lotPlanWork.cells - before.cells,
    planned: lotPlanWork.planned - before.planned,
    lots: plan.add.length,
  };
}

describe('the lots planned again after one road', () => {
  it('does the same work in a town of 9 blocks and of 81', () => {
    const small = editWork(3);
    const large = editWork(9);
    expect(small.lots).toBeGreaterThan(0);
    expect(large).toEqual(small);
    // The street drawn and nothing else of the town.
    expect(large.planned).toBe(1);
  });
});
