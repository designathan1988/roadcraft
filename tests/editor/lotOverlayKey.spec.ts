import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/** THE FAINT ZONES ARE NOT MADE AGAIN ON EVERY FRAME. */
describe('the lots overlay with the other tools', () => {
  it('is kept while the lots stand, and made again when they change', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    expect(doc.lots.length).toBeGreaterThan(3);
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
      mutate: (fn) => { fn(); },
      hint: () => {},
      redraw: () => {},
    });
    expect(tool.anyZoned()).toBe(false);

    zoneLots(doc, [doc.lots[0]!.id, doc.lots[1]!.id], { use: 'residential', density: 'low' });
    expect(tool.anyZoned()).toBe(true);
    const first = tool.overlayKeyed(false);
    expect(first.polygons).toHaveLength(2);
    expect(first.polygons).toEqual(tool.overlay(false).polygons);
    // Frames go by: the very same overlay, not made again.
    expect(tool.overlayKeyed(false)).toBe(first);

    zoneLots(doc, [doc.lots[2]!.id], { use: 'commercial', density: 'low' });
    const next = tool.overlayKeyed(false);
    expect(next).not.toBe(first);
    expect(next.key).not.toBe(first.key);
    expect(next.polygons).toHaveLength(3);
    expect(next.polygons).toEqual(tool.overlay(false).polygons);
  });

  it('in the Zoning tool is kept while nothing it reads changed, and made again when the pointer or the lots move', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
      mutate: (fn) => { fn(); },
      hint: () => {},
      redraw: () => {},
    });
    // The proposal of the street land is worked out first (a cached overlay must not stop it half done).
    while (tool.advanceProposal(50)) { /* until ready */ }
    const first = tool.overlayKeyed(true);
    expect(tool.overlayKeyed(true)).toBe(first);
    expect(first.polygons).toEqual(tool.overlay(true).polygons);

    tool.hover = { x: m(10), y: m(10) };
    const moved = tool.overlayKeyed(true);
    expect(moved).not.toBe(first);
    expect(tool.overlayKeyed(true)).toBe(moved);

    zoneLots(doc, [doc.lots[0]!.id], { use: 'residential', density: 'low' });
    const zoned = tool.overlayKeyed(true);
    expect(zoned).not.toBe(moved);
    expect(zoned.polygons).toEqual(tool.overlay(true).polygons);
  });
});
