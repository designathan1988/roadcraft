import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { grassClump } from '@render/grass';

/** Every tuft's ground position, rounded to a centimetre-ish grid. */
function tufts(doc: RoadDoc): Set<string> {
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, () => 0);
  const out = new Set<string>();
  for (const item of doc.landscape.values()) {
    if (item.kind !== 'meadow') continue;
    const clump = grassClump(elevation, () => 0, item);
    for (const t of [...clump.tufts, ...clump.flowers]) out.add(`${Math.round(t.x * 10)},${Math.round(t.y * 10)}`);
  }
  return out;
}

/**
 * Drawing a road anywhere moved 90 % of the grass on screen: placement drew
 * from one random stream shared by the whole map. A placed clump is seeded by
 * its own id now (no grass grows by itself any more), so an edit elsewhere
 * moves none of it.
 */
describe('grass placement', () => {
  function grid(): RoadDoc {
    const doc = new RoadDoc();
    const nodes = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nodes.push(doc.addNode({ x: i * 300 - 300, y: j * 300 - 300 }));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const here = nodes[i * 3 + j]!;
        if (i < 2) doc.addSegment(here.id, nodes[(i + 1) * 3 + j]!.id, 2);
        if (j < 2) doc.addSegment(here.id, nodes[i * 3 + j + 1]!.id, 1);
      }
    }
    // Long grass placed in the blocks and beside the roads.
    for (let k = 0; k < 60; k++) doc.addLandscape('meadow', { x: -280 + (k % 10) * 57, y: -280 + Math.floor(k / 10) * 97 });
    return doc;
  }

  it('is the same grass after a road is drawn somewhere else', () => {
    const before = tufts(grid());
    expect(before.size).toBeGreaterThan(2_000);
    const edited = grid();
    const a = edited.addNode({ x: 900, y: -900 });
    const b = edited.addNode({ x: 1_050, y: -920 });
    edited.addSegment(a.id, b.id, 1);
    const after = tufts(edited);
    let kept = 0;
    for (const key of before) if (after.has(key)) kept++;
    // The new road is 1 000 units from the grid; nothing near the grid moves.
    expect(kept / before.size).toBeGreaterThan(0.97);
  });

  it('is the same grass every time it is built', () => {
    expect([...tufts(grid())].sort()).toEqual([...tufts(grid())].sort());
  });
});
