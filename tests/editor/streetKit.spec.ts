import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { onCarriageway } from '@world/carriageway';
import { layPowerLines } from '@editor/roads/powerLine';
import { carryStreetKit } from '@editor/roads/streetKit';
import { furnitureFor } from '@world/roads/furnitureSets';
import { m } from '@world/units';

/** A STREET WIDENED OR MOVED TAKES ITS POWER LINE AND FURNITURE ALONG: none left in its lanes */
function furnished(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: m(300), y: 0 });
  doc.addSegment(a.id, b.id, 1, null);
  const net = new Network(doc);
  net.rebuild();
  const ids = [...doc.segments.keys()];
  const power = layPowerLines(doc, net, ids) > 0;
  for (const piece of furnitureFor(net, ids, 'complete', null, power)) doc.addLandscape(piece.kind, piece.at);
  net.rebuild();
  return { doc, net };
}

describe('a street\'s power line and furniture through an edit of its road', () => {
  it('leaves no pole or piece in the lanes of a street made an avenue', () => {
    const { doc, net } = furnished();
    const id = [...doc.segments.keys()][0]!;
    const poles = doc.poles.size;
    expect(poles).toBeGreaterThan(3);
    expect(carryStreetKit(doc, net, [id], () => { doc.setSegmentType(id, 2); return true; })).toBe(true);
    net.rebuild();
    expect(doc.poles.size).toBeGreaterThan(3);
    for (const pole of doc.poles.values()) expect(onCarriageway(net, pole), `pole ${pole.id}`).toBe(false);
    for (const item of doc.landscape.values()) expect(onCarriageway(net, item), `${item.kind} ${item.id}`).toBe(false);
  });

  it('moves the line with a street moved sideways', () => {
    const { doc, net } = furnished();
    const id = [...doc.segments.keys()][0]!;
    const seg = doc.segment(id)!;
    carryStreetKit(doc, net, [id], () => {
      doc.moveNode(seg.a, { x: 0, y: m(60) });
      doc.moveNode(seg.b, { x: m(300), y: m(60) });
      return true;
    });
    net.rebuild();
    expect(doc.poles.size).toBeGreaterThan(3);
    for (const pole of doc.poles.values()) expect(Math.abs(pole.y - m(60))).toBeLessThan(m(15));
  });

  it('leaves the map as it was when the edit is refused', () => {
    const { doc, net } = furnished();
    const id = [...doc.segments.keys()][0]!;
    const poles = doc.poles.size, items = doc.landscape.size;
    expect(carryStreetKit(doc, net, [id], () => false)).toBe(false);
    expect(doc.poles.size).toBe(poles);
    expect(doc.landscape.size).toBe(items);
  });
});
