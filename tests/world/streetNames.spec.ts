import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { nameFor, streetNameOf, streetNumbers } from '@world/roads/streetNames';
import { METERS_PER_UNIT } from '@world/units';

/**
 * STREET NAMES AND NUMBERS (docs/VIAS.md V8): one name per street, none
 * twice; the numbers run in metres from the end nearer the map's centre and
 * carry on through the junctions.
 */
function town() {
  const doc = new RoadDoc();
  const n = [100, 200, 300, 400].map((x) => doc.addNode({ x, y: 0 }).id);
  const side = doc.addNode({ x: 200, y: 150 }).id;
  const s1 = doc.addSegment(n[0]!, n[1]!, 1)!.id;
  const s2 = doc.addSegment(n[2]!, n[1]!, 1)!.id;
  const s3 = doc.addSegment(n[2]!, n[3]!, 1)!.id;
  const cross = doc.addSegment(n[1]!, side, 1)!.id;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, s1, s2, s3, cross };
}

describe('street names and numbers', () => {
  it('one name per street, different names, found again from any of its stretches', () => {
    const { doc, net, s1, s2, s3, cross } = town();
    const names = nameFor(net, [s1, s2, s3, cross]);
    expect(names.length).toBe(2);
    expect(new Set(names.map((x) => x.text)).size).toBe(2);
    for (const name of names) doc.addLandscape('streetname', name.at, { text: name.text });
    expect(streetNameOf(net, s3)).toBe(streetNameOf(net, s1));
    expect(streetNameOf(net, cross)).not.toBe(streetNameOf(net, s1));
    expect(nameFor(net, [s1, s2, s3, cross])).toEqual([]);
  });

  it('numbers from the end nearer the centre, carried on through the junction', () => {
    const { doc, net, s1, s2, s3 } = town();
    const a = streetNumbers(doc, net, s1)!, b = streetNumbers(doc, net, s2)!, c = streetNumbers(doc, net, s3)!;
    expect(a.from).toBe(0);
    expect(b.from).toBe(a.to);
    expect(c.from).toBe(b.to);
    expect(c.to).toBeCloseTo(300 * METERS_PER_UNIT, -1);
  });
});
