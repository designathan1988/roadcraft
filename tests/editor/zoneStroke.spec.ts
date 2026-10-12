import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { lotCentre } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/**
 * A ZONE STROKE IS NEVER LOST (Etapa 5g). The proposed lots along the
 * streets are worked out over frames and start again with every new lot; a
 * stroke made meanwhile found no proposed lot under it and zoned nothing,
 * silently (`lotTool.ts` `proposedAt` -1). Its points now wait for the
 * proposal, and a stroke let go before it is ready finishes it there and then.
 */
describe('the zone brush over street land', () => {
  it('zones what a stroke passed while the proposal was being worked out', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    const hints: string[] = [];
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
      mutate: (fn) => { fn(); },
      hint: (key) => hints.push(key),
      redraw: () => {},
    });
    // No frame has worked the proposal out yet: the stroke runs along the street's side.
    expect(tool.proposalReady()).toBe(-1);
    tool.down(1, { x: m(-60), y: m(14) }, false, 1);
    for (let x = -60; x <= 60; x += 4) tool.move(1, { x: m(x), y: m(14) });
    tool.up(1, true);
    // Let go before the proposal was ready: the rest of it is worked out at
    // once (some 0.2 s on the planet at its worst), so the zone shows the
    // moment the button is let go - no "working it out" wait.
    expect(hints).not.toContain('hint.zone.pending');
    expect(hints).not.toContain('hint.zone.empty');
    expect(hints).toContain('hint.zone.painted');
    const zoned = doc.lots.filter((l) => l.use === 'residential');
    expect(zoned.length).toBeGreaterThan(2);
  });

  it('zones every lot a fast stroke passed, not only those under its samples', () => {
    // A fast drag reports its pointer far apart (the browser coalesces the
    // moves): one report at each end of 120 m of street.
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
      mutate: (fn) => { fn(); },
      hint: () => {},
      redraw: () => {},
    });
    while (tool.advanceProposal()) { /* the proposal worked out first */ }
    tool.down(1, { x: m(-100), y: m(14) }, false, 1);
    tool.move(1, { x: m(100), y: m(14) });
    tool.up(1, true);
    const zoned = doc.lots.filter((l) => l.use === 'residential' && lotCentre(l).y > 0)
      .map((l) => lotCentre(l).x).sort((p, q) => p - q);
    // The whole run between the two reports, lot after lot.
    expect(zoned.length).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < zoned.length; i++) expect(zoned[i]! - zoned[i - 1]!).toBeLessThan(m(30));
  });
});
