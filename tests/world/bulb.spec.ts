import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { m } from '@world/units';
import { BULB_RADIUS, clearBulbs } from '@world/junction/bulb';
import { levelPolygons } from '@world/surfaces';
import { area } from '@core/clipper';
import { buildWalkways } from '@world/walkways';
import { junctionDetail } from '@world/markings';

/**
 * A ROAD'S END CAN BE A TURNING CIRCLE (docs/VIAS.md V8, the player's choice
 * per end, 2026-10-10): a circle of carriageway round the end, every outer
 * surface carried out round it, the road cut where its edge meets it.
 */
function street(): { doc: RoadDoc; net: Network; end: number } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(60), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, end: b };
}

describe('a turning circle at a road end', () => {
  it('is drawn round the end when the player asks for one, and only then', () => {
    const { doc, net, end } = street();
    expect(net.junctions.has(end as never)).toBe(false);
    const before = Math.abs(area(levelPolygons(net, Level.Asphalt)));
    doc.setNodeEnd(end as never, 'bulb');
    net.rebuild();
    const byLevel = net.junctions.get(end as never);
    expect(byLevel?.get(Level.Asphalt)?.legs.length).toBe(1);
    const after = Math.abs(area(levelPolygons(net, Level.Asphalt)));
    // The circle's area, less the half of the road it covers, was added.
    const circle = Math.PI * BULB_RADIUS * BULB_RADIUS;
    expect(after - before).toBeGreaterThan(circle * 0.75);
    expect(after - before).toBeLessThan(circle * 1.05);
    // The footway goes round it too, wider than the carriageway.
    const asphalt = byLevel!.get(Level.Asphalt)!.ring.flatten();
    const footway = byLevel!.get(Level.Sidewalk)!.ring.flatten();
    // Measured on the side away from the road (the road runs west from the end; its kerb returns reach further).
    const reach = (pts: { x: number; y: number }[]): number => Math.max(...pts.filter((p) => p.x >= m(60)).map((p) => Math.hypot(p.x - m(60), p.y)));
    expect(reach(asphalt)).toBeCloseTo(BULB_RADIUS, 0);
    expect(reach(footway)).toBeGreaterThan(reach(asphalt) + m(1));
    // Asked back to be the map's edge, it is the plain end again.
    doc.setNodeEnd(end as never, undefined);
    net.rebuild();
    expect(net.junctions.has(end as never)).toBe(false);
    expect(Math.abs(area(levelPolygons(net, Level.Asphalt)))).toBeCloseTo(before, 3);
  });

  it('is walked round on its footway, not across', () => {
    const { doc, net, end } = street();
    doc.setNodeEnd(end as never, 'bulb');
    net.rebuild();
    const g = buildWalkways(net);
    const here = g.ways.filter((w) => w.node === end);
    // No crossing over the circle; one walk round it, joining the street's two footways.
    expect(here.filter((w) => w.kind === 'crossing')).toEqual([]);
    const round = here.filter((w) => w.kind === 'corner');
    expect(round.length).toBe(1);
    const path = round[0]!.path;
    // Round the far side, on the footway: outside the carriageway's circle all the way.
    let nearest = Infinity, farthestBack = -Infinity;
    for (let s = 0; s <= path.length; s += m(0.5)) {
      const p = path.sampleAt(s).p;
      nearest = Math.min(nearest, Math.hypot(p.x - m(60), p.y));
      farthestBack = Math.max(farthestBack, p.x - m(60));
    }
    expect(nearest).toBeGreaterThan(BULB_RADIUS);
    expect(farthestBack).toBeGreaterThan(BULB_RADIUS);
    // And nothing painted across its mouth: no zebra, no stop line.
    const detail = junctionDetail(net);
    expect([...detail.zebras, ...detail.stops]).toEqual([]);
  });

  it('takes away what stood on the road end it was made from', () => {
    const { doc, net, end } = street();
    // A pole and a bench on the end's footway, a pole well back along the street.
    const inCircle = doc.addPole({ x: m(56), y: m(7) });
    const back = doc.addPole({ x: m(20), y: m(7.5) });
    doc.addElements([{ kind: 'bench', x: m(58), y: m(-7), angle: 0 } as never]);
    doc.setNodeEnd(end as never, 'bulb');
    net.rebuild();
    expect(clearBulbs(doc, net)).toBe(2);
    expect(doc.poles.has(inCircle.id)).toBe(false);
    expect(doc.poles.has(back.id)).toBe(true);
    expect(doc.elements.length).toBe(0);
  });

  it('is kept in a saved map', () => {
    const { doc, end } = street();
    doc.setNodeEnd(end as never, 'bulb');
    const again = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(again.node(end as never)?.end).toBe('bulb');
  });
});
