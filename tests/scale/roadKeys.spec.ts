import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';
import { buildRoadElevation } from '@world/elevation';

/** A ROAD EDIT KEYS WHAT IT REBUILDS BY NUMBERS (`Digest`), NOT BY JSON TEXT, ON A SMALL MAP AND A LARGE ONE */
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

const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

afterEach(() => { vi.restoreAllMocks(); });

/** The JSON texts written while the network and the roads' heights follow one road laid beside a grid of n x n blocks. */
function textsWritten(n: number): number {
  const doc = grid(n);
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, ground);
  const x = BLOCK * (n / 2 + 2);
  const a = doc.addNode({ x, y: 0 }), b = doc.addNode({ x: x + m(60), y: 0 });
  doc.setNodeHeightOffset(b.id, m(3));
  doc.addSegment(a.id, b.id, 1);
  const stringify = vi.spyOn(JSON, 'stringify');
  net.rebuild();
  buildRoadElevation(net, ground, elevation);
  const calls = stringify.mock.calls.length;
  stringify.mockRestore();
  return calls;
}

describe('the keys of a road edit', () => {
  it('write no JSON text, whatever the size of the map', () => {
    expect(textsWritten(3)).toBe(0);
    expect(textsWritten(12)).toBe(0);
  });

  it('still see a road whose curve or lanes changed', () => {
    const doc = grid(3);
    const net = new Network(doc);
    net.rebuild();
    const id = [...doc.segments.keys()][0] as SegmentId;
    const before = net.ribbons.get(id);
    doc.setSegmentCurve(id, { t: 0.5, h: m(6) });
    net.rebuild();
    const curved = net.ribbons.get(id);
    expect(curved).not.toBe(before);
    doc.setSegmentLanes(id, 4);
    net.rebuild();
    expect(net.ribbons.get(id)).not.toBe(curved);
  });
});
