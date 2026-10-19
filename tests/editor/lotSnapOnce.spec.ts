import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/** EDT-05: drawing a lot snaps the pointer once a refresh, not three times (each snap unites the footways near it). */
describe('the lot drawn by points', () => {
  it('snaps the pointer once for its line, its marker and its length', async () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'polygon', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
      mutate: (fn) => { fn(); },
      hint: () => {},
      redraw: () => {},
      plan: async () => planLots(doc, net),
    });
    await tool.advanceProposal();
    let snaps = 0;
    const own = tool as unknown as { snap(p: { x: number; y: number }): { x: number; y: number } };
    const snap = own.snap.bind(tool);
    own.snap = (p) => { snaps++; return snap(p); };
    tool.down(0, { x: m(-10), y: m(30) }, false, 1);
    tool.up(0, true);
    snaps = 0;
    tool.hover = { x: m(12), y: m(40) };
    tool.overlay(true);
    expect(snaps).toBe(1);
  });
});
