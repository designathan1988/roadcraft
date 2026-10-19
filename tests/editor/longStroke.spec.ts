import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { RoadTool, type RoadToolHost } from '@editor/roadTool';

/** EDT-11: a free stroke keeps its samples past the first 256 (one a metre), so a long one does not run straight from its 256th sample to its end. */
describe('a long free stroke', () => {
  it('keeps every sample of a short stroke and the far bend of a long one', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const host: RoadToolHost = {
      doc, net, zoom: () => 1, px: (n) => n,
      settings: () => ({ typeIndex: 1, lanes: null, alignment: 'free', heightOffset: 0, parking: undefined, width: null, grid: false }),
      setHeight: () => {}, worldAtScreen: (x, y) => ({ x, y }), naturalHeightAt: () => 0, offerElevation: () => {},
      flash: () => {}, mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    };
    const tool = new RoadTool(host);
    tool.draft = {
      start: { kind: 'free', at: { x: 0, y: 0 } }, startHeightOffset: 0, chained: false, pressedAt: { x: 0, y: 0 },
      snap: { at: { x: 0, y: 0 }, guide: null, angleDeg: 0, length: 0 } as never, samples: [{ at: { x: 0, y: 0 }, heightOffset: 0 }], heightOffset: 0,
    };
    // 400 events a quarter metre apart east, then 400 a metre apart north: the bend comes after the 256th sample.
    for (let k = 1; k <= 400; k++) tool.move({ x: m(0.25) * k, y: 0 });
    for (let k = 1; k <= 400; k++) tool.move({ x: m(100), y: m(1) * k });
    const samples = tool.draft!.samples;
    // The first 256 as they came (sub-metre ones too).
    expect(samples[255]!.at.x).toBeCloseTo(m(0.25) * 255);
    // And the stroke's north leg is there.
    expect(Math.max(...samples.map((s) => s.at.y))).toBeGreaterThan(m(390));
  });
});
