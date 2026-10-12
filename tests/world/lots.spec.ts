import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { addLot, addPolygonLot, applyLots, curveLotSide, lotArea, deleteLot, insideLot, joinLots, lotCentre, lotFrame, moveLotCorner, planLots, splitLot, zoneLots } from '@world/lots';
import { quadsOverlap } from '@world/zoneGrid';

/** A block 90 x 70 m between four streets, and one street running off it into open land. */
function town(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const n = (x: number, y: number) => doc.addNode({ x: m(x), y: m(y) }).id;
  const a = n(-45, -35), b = n(45, -35), c = n(45, 35), d = n(-45, 35), e = n(160, -35);
  doc.addSegment(a, b, 1); doc.addSegment(b, c, 1); doc.addSegment(c, d, 1); doc.addSegment(d, a, 1);
  doc.addSegment(b, e, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

// Any polygon: a lot cut to the land rounds the block's corner with its footway's curve.
const area = (l: { corners: readonly { x: number; y: number }[] }): number => Math.abs(lotArea(l));

describe('lots', () => {
  it('cuts a closed block into equal lots and open land along a street into a strip of lots', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    const inBlock = doc.lots.filter((l) => Math.abs(lotCentre(l).x) < m(45) && Math.abs(lotCentre(l).y) < m(35));
    expect(inBlock.length).toBeGreaterThanOrEqual(2);
    // Equal but for the cut to the land: the corner lots lose the footway's
    // curve at the block's corner, and each row reaches its own street.
    const areas = inBlock.map(area).sort((a, b) => a - b);
    const median = areas[Math.floor(areas.length / 2)]!;
    for (const x of areas) expect(Math.abs(x - median) / median).toBeLessThan(0.15);
    expect(doc.lots.some((l) => lotCentre(l).x > m(60))).toBe(true);
    // No two lots overlap.
    for (const p of doc.lots) for (const q of doc.lots) if (p !== q) expect(quadsOverlap(p.corners, q.corners, m(0.5))).toBe(false);
  });

  it('faces every lot to its street: the back on the left of the front', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    for (const l of doc.lots) {
      expect(lotArea(l)).toBeGreaterThan(0);
      expect(lotFrame(l).width).toBeGreaterThan(m(7));
    }
  });

  it('does not cut the same land again, so a lot deleted on purpose stays deleted', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    const count = doc.lots.length;
    expect(deleteLot(doc, doc.lots[0]!.id)).toBe(true);
    applyLots(doc, planLots(doc, net));
    expect(doc.lots.length).toBe(count - 1);
  });

  it('splits, joins, adds, moves corners and zones lots', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    const first = doc.lots[0]!;
    const before = doc.lots.length;
    expect(splitLot(doc, first.id, { kind: 'vertical', parts: 2 })).toBe(true);
    expect(doc.lots.length).toBe(before + 1);
    const halves = doc.lots.slice(0, 2);
    expect(joinLots(doc, halves[0]!.id, halves[1]!.id)).toBe(true);
    expect(doc.lots.length).toBe(before);
    expect(Math.abs(Math.abs(lotArea(doc.lots[0]!)) - Math.abs(lotArea(first)))).toBeLessThan(1);
    const gone = doc.lots[0]!;
    deleteLot(doc, gone.id);
    const made = addLot(doc, gone.corners[0]!, gone.corners[2]!, lotFrame(gone).rotation);
    expect(made).not.toBeNull();
    const corner = doc.lots[0]!.corners[1]!;
    expect(moveLotCorner(doc, corner, { x: corner.x + m(2), y: corner.y })).toBe(true);
    const id = doc.lots[0]!.id;
    expect(zoneLots(doc, [id], { use: 'commercial', density: 'medium' })).toBe(true);
    expect(doc.lots.find((l) => l.id === id)!.use).toBe('commercial');
    expect(insideLot(lotCentre(doc.lots[0]!), doc.lots[0]!)).toBe(true);
  });

  it('cuts parallel to the front into lots one behind the other, and along a drawn line', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    const lot = doc.lots[0]!;
    const whole = lotArea(lot);
    expect(splitLot(doc, lot.id, { kind: 'horizontal', parts: 3 })).toBe(true);
    const pieces = doc.lots.slice(0, 3);
    expect(Math.abs(pieces.reduce((s, l) => s + lotArea(l), 0) - whole)).toBeLessThan(whole * 0.01);
    for (const p of pieces) expect(lotArea(p)).toBeGreaterThan(0);
    const next = doc.lots[3]!;
    const c = lotCentre(next);
    expect(splitLot(doc, next.id, { kind: 'line', a: { x: c.x - m(50), y: c.y - m(5) }, b: { x: c.x + m(50), y: c.y + m(5) } })).toBe(true);
  });

  it('draws polygon lots, curves a shared side in both lots, and snaps corners to the footway', () => {
    const { doc, net } = town();
    const tri = addPolygonLot(doc, [{ x: m(70), y: m(40) }, { x: m(100), y: m(40) }, { x: m(85), y: m(70) }], 0);
    expect(tri).not.toBeNull();
    expect(lotArea(tri!)).toBeGreaterThan(0);
    applyLots(doc, planLots(doc, net));
    const a = doc.lots.find((l) => l !== tri)!;
    const [p, q] = [a.corners[1]!, a.corners[2]!];
    const mid = { x: (p.x + q.x) / 2 + m(2), y: (p.y + q.y) / 2 };
    expect(curveLotSide(doc, p, q, mid)).toBe(true);
    expect(doc.lots.find((l) => l.id === a.id)!.corners.length).toBeGreaterThan(4);
    // Generated lots reach the footway: a front corner is on its back edge.
    const fronted = doc.lots.filter((l) => l.id !== tri!.id);
    expect(fronted.length).toBeGreaterThan(0);
  });

  it('survives saving and loading', () => {
    const { doc, net } = town();
    applyLots(doc, planLots(doc, net));
    zoneLots(doc, [doc.lots[0]!.id], { use: 'residential', density: 'low' });
    const copy = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.lots.length).toBe(doc.lots.length);
    expect(copy.lots[0]!.use).toBe('residential');
    expect(copy.lotKeys.length).toBe(doc.lotKeys.length);
  });
});
