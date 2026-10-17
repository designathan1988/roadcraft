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
