import { describe, expect, it, vi } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, planLots } from '@world/lots';
import { Bulldozer } from '@editor/bulldozer';

/** THE BULLDOZER'S BOX FINDS THE LOTS BY THEIR INDEX (`RoadDoc.lotsIn`), NEVER BY WALKING EVERY LOT */
describe('the bulldozer box', () => {
  it('takes the lots whose centre is inside it, the same as a walk over every lot, without reading the lot list', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const lots = doc.lots;
    expect(lots.length).toBeGreaterThan(4);
    // A box over the west half, off the road (its middle is east of the box).
    const x0 = m(-130), y0 = m(-60), x1 = m(-10), y1 = m(60);
    const inside = (p: { x: number; y: number }): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const expected = lots.filter((l) => inside(lotCentre(l))).map((l) => l.id).sort((p, q) => p - q);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(lots.length);
    const read = vi.spyOn(doc, 'lots', 'get');
    const tool = new Bulldozer({
      doc, net, bulldozeBuildingAt: () => false, poleReach: () => 1, itemReach: () => 1,
      mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    });
    tool.down(1, { x: 0, y: 0 }, { x: x0, y: y0 }, { kind: 'free', at: { x: x0, y: y0 } });
    tool.move(1, { x: 100, y: 100 }, { x: x1, y: y1 });
    tool.up(1, true);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    const left = new Set(doc.lots.map((l) => l.id));
    expect(expected.every((id) => !left.has(id))).toBe(true);
    expect(left.size).toBe(lots.length - expected.length);
  });
});

/** A CLICK ON A ROAD'S CARRIAGEWAY TAKES THE ROAD, NOT THE LAMP ON ITS FOOTWAY WITHIN PICK REACH */
describe('the bulldozer click', () => {
  function street(): { doc: RoadDoc; net: Network; tool: Bulldozer; segment: number } {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    const segment = doc.addSegment(a, b, 1)!.id;
    const net = new Network(doc);
    net.rebuild();
    doc.addLandscape('lamp', { x: 0, y: m(5) });
    doc.addPole({ x: m(10), y: -m(5) });
    // Zoomed out: a reach of some 7 m, past the kerb from the centre line.
    const tool = new Bulldozer({
      doc, net, bulldozeBuildingAt: () => false, poleReach: () => m(7), itemReach: () => m(7),
      mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    });
    return { doc, net, tool, segment };
  }
  const click = (tool: Bulldozer, at: { x: number; y: number }, anchor: Parameters<Bulldozer['down']>[3]): void => {
    tool.down(1, { x: 0, y: 0 }, at, anchor);
    tool.up(1, true);
  };

  it('removes the road clicked in its lanes, not only the lamp within reach: the street goes, its furniture with it', () => {
    const { doc, tool, segment } = street();
    click(tool, { x: m(2), y: 0 }, { kind: 'segment', segment, s: m(122), at: { x: m(2), y: 0 } } as never);
    expect(doc.segments.size).toBe(0);
    expect(doc.landscape.size).toBe(0);
    expect(doc.poles.size).toBe(0);
  });

  it('removes the lamp clicked on the footway', () => {
    const { doc, tool, segment } = street();
    click(tool, { x: 0, y: m(5) }, { kind: 'segment', segment, s: m(120), at: { x: 0, y: m(5) } } as never);
    expect(doc.landscape.size).toBe(0);
    expect(doc.segments.size).toBe(1);
  });
});
