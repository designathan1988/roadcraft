import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, planLots, zoneLots } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/** A town of one street with its lots, and the Zoning tool over it. */
function street(): { doc: RoadDoc; tool: LotTool } {
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
  return { doc, tool };
}

const lotGroups = (names: Iterable<string>): string[] => [...names].filter((name) => name.startsWith('l'));

/** THE LOTS OVERLAY IS NOT MADE AGAIN ON EVERY FRAME, NOR WHOLE WHEN ONE LOT CHANGES. */
describe('the lots overlay', () => {
  it('with the other tools, keeps its groups while the lots stand, and makes again only the lot that changed', () => {
    const { doc, tool } = street();
    expect(doc.lots.length).toBeGreaterThan(3);
    expect(tool.anyZoned()).toBe(false);
    const reader = {};

    zoneLots(doc, [doc.lots[0]!.id, doc.lots[1]!.id], { use: 'residential', density: 'low' });
    expect(tool.anyZoned()).toBe(true);
    const book = tool.overlay(false);
    expect(lotGroups(book.groups.keys())).toHaveLength(2);
    // A new reader is told everything once.
    expect(book.changedFor(reader)).toBeNull();
    // Frames go by: nothing made again.
    expect(tool.overlay(false)).toBe(book);
    expect([...book.changedFor(reader)!]).toEqual([]);

    zoneLots(doc, [doc.lots[2]!.id], { use: 'commercial', density: 'low' });
    tool.overlay(false);
    expect(lotGroups(book.changedFor(reader)!)).toEqual([`l${doc.lots[2]!.id}`]);
    expect(lotGroups(book.groups.keys())).toHaveLength(3);
  });

  it('in the Zoning tool, makes again only the lots the pointer and the edits reach', () => {
    const { doc, tool } = street();
    // The proposal of the street land is worked out first.
    tool.advanceProposal();
    const reader = {};
    const book = tool.overlay(true);
    // Every lot is drawn in the tool.
    expect(lotGroups(book.groups.keys())).toHaveLength(doc.lots.length);
    expect(book.changedFor(reader)).toBeNull();
    tool.overlay(true);
    expect([...book.changedFor(reader)!]).toEqual([]);

    // The pointer over a lot: that lot alone (lit under the brush).
    const lot = doc.lots[0]!;
    tool.hover = lotCentre(lot);
    tool.overlay(true);
    expect(lotGroups(book.changedFor(reader)!)).toEqual([`l${lot.id}`]);
    tool.overlay(true);
    expect([...book.changedFor(reader)!]).toEqual([]);

    // One lot zoned: its group, not every lot's.
    zoneLots(doc, [doc.lots[1]!.id], { use: 'residential', density: 'low' });
    tool.overlay(true);
    const changed = lotGroups(book.changedFor(reader)!);
    expect(changed).toContain(`l${doc.lots[1]!.id}`);
    expect(changed.length).toBeLessThan(doc.lots.length);
  });
});
