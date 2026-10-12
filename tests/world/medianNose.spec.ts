import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { medianAt, medianNose } from '@world/landscape';
import { Network } from '@world/network';
import { m } from '@world/units';

// A boulevard's median island stops short of the crossing at a junction: the
// zebra is crossed on the road, never over a kerbed, planted island
// (2026-10-09: people stood on the grass halfway across).
describe('median nose', () => {
  it('stands back of the crossing, and nothing is planted on the zebra', () => {
    const doc = new RoadDoc();
    const west = doc.addNode({ x: 0, y: 0 }), mid = doc.addNode({ x: 400, y: 0 }), east = doc.addNode({ x: 800, y: 0 });
    const boulevard = doc.addSegment(west.id, mid.id, 3)!;
    doc.addSegment(mid.id, east.id, 3);
    doc.addSegment(doc.addNode({ x: 400, y: -300 }).id, mid.id, 1);
    doc.addSegment(mid.id, doc.addNode({ x: 400, y: 300 }).id, 1);
    const net = new Network(doc);
    net.rebuild();
    const crossing = net.crosswalkDistanceAt(boulevard.id, mid.id);
    expect(crossing).toBeGreaterThan(0);
    const nose = medianNose(net, boulevard.id, mid.id);
    expect(nose).toBeGreaterThan(crossing);
    // On the zebra (its centre on the boulevard's centre line): no island.
    expect(medianAt(net, { x: 400 - crossing, y: 0 })).toBeNull();
    // A little past the nose: the island.
    expect(medianAt(net, { x: 400 - nose - m(2), y: 0 })).not.toBeNull();
  });
});
