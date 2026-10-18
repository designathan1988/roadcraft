import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { layPowerLines, openStretch } from '@editor/roads/powerLine';
import { m } from '@world/units';

/** A STREET'S POWER LINE STAYS OUT OF ITS TUNNEL: poles only where the road is not buried */
function street(heightA: number, heightB: number): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: m(300), y: 0 });
  doc.setNodeHeightOffset(a.id, heightA);
  doc.setNodeHeightOffset(b.id, heightB);
  doc.addSegment(a.id, b.id, 1, null);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

describe('a street\'s power line and its tunnel', () => {
  it('runs the whole street at grade and on a raised one', () => {
    expect(openStretch(0, 0)).toEqual([0, 1]);
    expect(openStretch(m(8), m(8))).toEqual([0, 1]);
  });

  it('is not laid along a road buried end to end', () => {
    expect(openStretch(-m(8), -m(8))).toBeNull();
    const { doc, net } = street(-m(8), -m(8));
    expect(layPowerLines(doc, net, [...doc.segments.keys()])).toBe(0);
    expect(doc.poles.size).toBe(0);
  });

  it('stops where a road going down into the ground is buried', () => {
    const open = openStretch(0, -m(8))!;
    expect(open[0]).toBe(0);
    expect(open[1]).toBeGreaterThan(0);
    expect(open[1]).toBeLessThan(0.1);
    const { doc, net } = street(0, 0);
    layPowerLines(doc, net, [...doc.segments.keys()]);
    const whole = doc.poles.size;
    expect(whole).toBeGreaterThan(3);
    const ramp = street(0, -m(2));
    layPowerLines(ramp.doc, ramp.net, [...ramp.doc.segments.keys()]);
    for (const pole of ramp.doc.poles.values()) expect(pole.x).toBeLessThan(m(300) * 0.25 + m(8));
  });
});
