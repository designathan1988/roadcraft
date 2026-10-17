import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { RoadTool, type RoadToolHost } from '@editor/roadTool';

/** THE ROAD IN HAND IS JUDGED AGAIN WHEN IT OR THE MAP ROUND IT MOVES, NOT WHEN SOMETHING CHANGES ELSEWHERE (`RoadTool.verdict`, plan S3) */

afterEach(() => { vi.useRealTimers(); });

describe('the verdict of the road in hand', () => {
  it('is worked out again for a change near the draft, never for one far from it, nor each frame', () => {
    vi.useFakeTimers();
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const host: RoadToolHost = {
      doc, net, zoom: () => 1, px: (n) => n,
      settings: () => ({ typeIndex: 1, lanes: null, alignment: 'straight', heightOffset: 0, parking: undefined, width: null, grid: false }),
      setHeight: () => {}, worldAtScreen: (x, y) => ({ x, y }), naturalHeightAt: () => 0, offerElevation: () => {},
      flash: () => {}, mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    };
    const tool = new RoadTool(host);
    const judged = vi.spyOn(tool as unknown as { judge(key: unknown): void }, 'judge');
    tool.draft = {
      start: { kind: 'free', at: { x: 0, y: 0 } }, startHeightOffset: 0, chained: false, pressedAt: { x: 0, y: 0 },
      snap: { at: { x: m(200), y: 0 }, guide: null, angleDeg: 0, length: m(200) } as never, samples: [{ at: { x: 0, y: 0 }, heightOffset: 0 }], heightOffset: 0,
    };
    const frames = (n: number): void => { for (let k = 0; k < n; k++) { tool.verdict(); vi.advanceTimersByTime(50); } };
    frames(10);
    expect(judged).toHaveBeenCalledTimes(1);
    // A road drawn two kilometres off: the draft is not judged again.
    const a = doc.addNode({ x: m(2000), y: m(2000) }), b = doc.addNode({ x: m(2100), y: m(2000) });
    doc.addSegment(a.id, b.id, 1);
    net.rebuild();
    frames(10);
    expect(judged).toHaveBeenCalledTimes(1);
    // One across the draft: judged again, once.
    const c = doc.addNode({ x: m(100), y: m(-100) }), d = doc.addNode({ x: m(100), y: m(100) });
    doc.addSegment(c.id, d.id, 1);
    net.rebuild();
    frames(10);
    expect(judged).toHaveBeenCalledTimes(2);
  });
});
