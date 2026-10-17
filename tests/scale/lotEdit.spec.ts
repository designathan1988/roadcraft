import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { applyLots } from '@world/lots';
import { m } from '@world/units';
import { LotTool, type LotSplitKind, type ZoneMode } from '@editor/lotTool';

/** THE ZONING TOOL'S GESTURES LOOK AT THE LOTS NEAR THE POINTER, NOT AT EVERY LOT OF THE TOWN (`edit.spec.ts`'s rule) */
const SIDE = m(20);
const GAP = m(4);

/** A square town of n x n lots, and the lots its store hands out counted from now on. */
function town(n: number): { doc: RoadDoc; net: Network; reads: { count: number } } {
  const doc = new RoadDoc();
  const add: { key: string; corners: Vec2[] }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * (SIDE + GAP), y = j * (SIDE + GAP);
      add.push({ key: '', corners: [{ x, y }, { x: x + SIDE, y }, { x: x + SIDE, y: y + SIDE }, { x, y: y + SIDE }] });
    }
  }
  applyLots(doc, { add, keys: [], drop: [] });
  const net = new Network(doc);
  net.rebuild();
  const reads = { count: 0 };
  const store = doc.lotStore;
  const all = store.all.bind(store), list = store.list.bind(store), within = store.in.bind(store);
  store.all = function* () { for (const lot of all()) { reads.count++; yield lot; } };
  store.list = () => { const out = list(); reads.count += out.length; return out; };
  store.in = (rect) => { const out = within(rect); reads.count += out.length; return out; };
  return { doc, net, reads };
}

/** The lots looked at by one gesture of each mode in the corner of the town, and by a stroke across a few lots. */
function gestureReads(n: number): Record<string, number> {
  const out: Record<string, number> = {};
  const at = (i: number, j: number): Vec2 => ({ x: i * (SIDE + GAP) + SIDE / 2, y: j * (SIDE + GAP) + SIDE / 2 });
  const corner = (i: number, j: number): Vec2 => ({ x: i * (SIDE + GAP), y: j * (SIDE + GAP) });
  const run = (mode: ZoneMode, gesture: (tool: LotTool) => void, splitKind: LotSplitKind = 'vertical',
    prepare: (tool: LotTool) => void = () => {}): number => {
    const { doc, net, reads } = town(n);
    const tool = new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode, use: 'residential', density: 'low', eraser: false, splitKind, splitParts: 2 }),
      mutate: (fn) => { fn(); },
      hint: () => {},
      redraw: () => {},
    });
    prepare(tool);
    reads.count = 0;
    gesture(tool);
    return reads.count;
  };
  // Taking the zone off (shift): the stroke's lots by place. Over land with no lot, zoning waits on the proposal (`planLots`).
  out.brush = run('brush', (tool) => { tool.down(1, at(1, 1), true, 1); tool.move(1, at(3, 1)); tool.up(1, true); });
  out.erase = run('delete', (tool) => { tool.down(1, at(1, 1), false, 1); tool.move(1, at(2, 1)); tool.up(1, true); });
  out.corner = run('edit', (tool) => { tool.down(1, corner(1, 1), false, 1); tool.move(1, { x: corner(1, 1).x + m(1), y: corner(1, 1).y }); tool.up(1, true); });
  out.front = run('front', (tool) => { tool.down(1, { x: corner(1, 1).x + SIDE / 2, y: corner(1, 1).y }, false, 1); });
  out.curve = run('curve', (tool) => { tool.down(1, { x: corner(1, 1).x + SIDE / 2, y: corner(1, 1).y }, false, 1); tool.up(1, false); });
  out.cut = run('split', (tool) => { tool.down(1, at(1, 1), false, 1); tool.move(1, at(2, 1)); tool.up(1, true); }, 'line');
  // The first question reads every lot once; after a stroke, only the lots it zoned.
  out.zoned = run('brush', (tool) => { tool.down(1, at(1, 1), false, 1); tool.up(1, true); tool.anyZoned(); }, 'vertical', (tool) => tool.anyZoned());
  return out;
}

describe('the zoning tool on a small town and a large one', () => {
  it('looks at the same lots for the same gesture, whatever the size of the town', () => {
    const small = gestureReads(6);
    const large = gestureReads(24);
    const report: string[] = [];
    for (const key of Object.keys(small)) {
      if (large[key]! > small[key]!) report.push(`${key}: ${small[key]} -> ${large[key]} lots looked at`);
    }
    expect(report).toEqual([]);
  });
});
