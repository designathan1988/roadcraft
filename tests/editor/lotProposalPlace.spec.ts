import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LotTool } from '@editor/lotTool';
import { m } from '@world/units';

/** The street land's proposed lots made real */
describe('the proposed lots taken in', () => {
  it('are written in the diary with their places', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 });
    const b = doc.addNode({ x: m(120), y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'edit', use: 'residential', density: 'low', eraser: false, splitKind: 'vertical', splitParts: 2 }),
      mutate: (fn) => { fn(); }, hint: () => undefined, redraw: () => undefined,
    });
    tool.advanceProposal(Infinity);
    expect(tool.proposalReady()).toBeGreaterThan(0);
    const before = doc.changes.version;
    tool.down(1, { x: m(500), y: m(500) }, false, 1);
    const lots = (doc.changes.since(before, ['lots']) ?? []);
    expect(lots.length).toBeGreaterThan(0);
    expect(lots.every((e) => e.rects !== null)).toBe(true);
    expect(doc.lots.length).toBeGreaterThan(0);
  });
});
