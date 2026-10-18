import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { congestionColour, roadOccupancy } from '@ui/overlay/congestion';

/** THE CONGESTION MAP READS HOW FULL A ROAD IS: a few cars at a light leave a long street green, a queue down its length makes it red */
describe('the congestion map', () => {
  const doc = new RoadDoc();
  const s = doc.addSegment(doc.addNode({ x: 0, y: 0 }).id, doc.addNode({ x: m(300), y: 0 }).id, 1)!.id;
  const net = new Network(doc);
  net.rebuild();
  it('leaves a street with three cars waiting green', () => {
    const occ = roadOccupancy(net, [{ segment: s }, { segment: s }, { segment: s }, { segment: undefined }]).get(s)!;
    expect(congestionColour(occ)).toBe('#57d06b');
  });
  it('paints a street queued end to end red', () => {
    const cars = Array.from({ length: 70 }, () => ({ segment: s }));
    expect(congestionColour(roadOccupancy(net, cars).get(s)!)).toBe('#e5372f');
  });
});
