import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId } from '@world/ids';
import { m } from '@world/units';
import { guardRoadEdit } from '@editor/editRules';

/** THE JUDGMENT OF A ROAD EDIT (`editRules.ts`) READS WHAT THE EDIT TOUCHED, NOT EVERY ROAD OF THE MAP (`edit.spec.ts`'s rule) */
const BLOCK = m(120);

function grid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: BLOCK * (i - n / 2), y: BLOCK * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
      if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
    }
  }
  return doc;
}

/** The marks of the map's sharp and squeezed junctions read while one road is laid beside a grid of n x n blocks. */
function marksRead(n: number): number {
  const doc = grid(n);
  const net = new Network(doc);
  net.rebuild();
  // Every junction of the grid marked as a map already holding them would be (they stand as they are; the edit is elsewhere).
  for (const id of doc.nodes.keys()) { net.impossible.set(id, 0.2); net.squeezed.set(id, m(0.1)); }
  let reads = 0;
  for (const map of [net.impossible, net.squeezed]) {
    const entries = map.entries.bind(map);
    map.entries = function* () { for (const entry of entries()) { reads++; yield entry; } return undefined; } as typeof map.entries;
    map[Symbol.iterator] = map.entries;
  }
  const x = BLOCK * (n / 2 + 2);
  const result = guardRoadEdit(doc, net, (work) => {
    const a = work.addNode({ x, y: 0 }), b = work.addNode({ x: x + m(60), y: 0 });
    work.addSegment(a.id, b.id, 1);
    return true;
  });
  expect(result).toEqual({ changed: true, refused: null });
  return reads;
}

describe('the judgment of a road edit', () => {
  it('reads no mark of the junctions the edit did not touch', () => {
    expect(marksRead(3)).toBe(0);
    expect(marksRead(12)).toBe(0);
  });
});
