import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { StreetscapeTool } from '@editor/streetscapeTool';
import type { LandscapeKind } from '@world/landscape';

/** The landscaping tool as the player uses it (`editor/streetscapeTool.ts`, taken out of `main.ts`). */
function setup(kind: LandscapeKind = 'bench'): { tool: StreetscapeTool; doc: RoadDoc; hints: string[] } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -400, y: 0 });
  const b = doc.addNode({ x: 400, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  const hints: string[] = [];
  const tool = new StreetscapeTool({
    doc, net, zoom: () => 2, kind: () => kind, extra: () => ({}),
    mutate: (fn) => { fn(); }, hint: (key) => hints.push(key), redraw: () => {},
  });
  return { tool, doc, hints };
}

describe('the landscaping tool', () => {
  it('shows where the item would go, and puts it on the footway on a click', () => {
    const { tool, doc } = setup();
    tool.move({ x: 0, y: 14 });
    expect(tool.hover?.ok).toBe(true);
    tool.down({ x: 0, y: 14 }, false);
    expect(doc.landscape.size).toBe(1);
    expect(tool.hover).toBeNull();
  });

  it('refuses open ground away from any footway, and says why', () => {
    const { tool, doc, hints } = setup();
    tool.down({ x: 0, y: 80 }, false);
    expect(doc.landscape.size).toBe(0);
    expect(hints[0]).toContain('hint.streetscape.');
  });

  it('takes an item away with Shift-click', () => {
    const { tool, doc, hints } = setup();
    tool.down({ x: 0, y: 14 }, false);
    const [item] = [...doc.landscape.values()];
    tool.down({ x: item!.x, y: item!.y }, true);
    expect(doc.landscape.size).toBe(0);
    expect(hints).toContain('hint.streetscape.removed');
  });
});
