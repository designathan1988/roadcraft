import { describe, expect, it, vi } from 'vitest';
import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { congestionColour, drawCongestion, roadOccupancy } from '@ui/overlay/congestion';

/** THE CONGESTION MAP READS HOW FULL A ROAD IS: a few cars at a light leave a long street green, a queue down its length makes it red */
describe('the congestion map', () => {
  const doc = new RoadDoc();
  const s = doc.addSegment(doc.addNode({ x: 0, y: 0 }).id, doc.addNode({ x: m(300), y: 0 }).id, 1)!.id;
  const net = new Network(doc);
  net.rebuild();
  it('leaves a street with three cars waiting green', () => {
    const occ = roadOccupancy(net, [{ segment: s }, { segment: s }, { segment: s }, { segment: undefined }]).get(s)!;
    expect(congestionColour(occ)).toBe('#57d06b');
  });
  it('paints a street queued end to end red', () => {
    const cars = Array.from({ length: 70 }, () => ({ segment: s }));
    expect(congestionColour(roadOccupancy(net, cars).get(s)!)).toBe('#e5372f');
  });
});

/** A canvas that writes down every point of every band drawn. */
function recordingCanvas(): { ctx: CanvasRenderingContext2D; drawn: number[][] } {
  const drawn: number[][] = [];
  const ctx = {
    save() {}, restore() {}, beginPath() { drawn.push([]); }, stroke() {},
    moveTo(x: number, y: number) { drawn[drawn.length - 1]!.push(x, y); },
    lineTo(x: number, y: number) { drawn[drawn.length - 1]!.push(x, y); },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, drawn };
}

describe('the congestion map drawn each frame', () => {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 }).id, b = doc.addNode({ x: m(300), y: m(40) }).id, c = doc.addNode({ x: m(500), y: m(400) }).id;
  doc.addSegment(a, b, 1);
  doc.addSegment(b, c, 2);
  const net = new Network(doc);
  net.rebuild();
  const view = [-m(50), -m(50), m(600), m(500)] as const;
  // A projection with a height, as the page's (`main.ts`): what it is given is read, never kept.
  const at = (p: Vec2): Vec2 => ({ x: p.x * 0.5 + 3, y: p.y * -0.25 + Math.sin(p.x) });

  it('draws each road where sampling its line every frame drew it', () => {
    const expected: number[][] = [];
    for (const ribbon of net.ribbonsMeeting(view)) {
      const line = ribbon.full;
      const steps = Math.max(2, Math.min(48, Math.ceil(line.length / 12)));
      const band: number[] = [];
      for (let k = 0; k <= steps; k++) { const p = at(line.sampleAt((k / steps) * line.length).p); band.push(p.x, p.y); }
      expected.push(band);
    }
    const { ctx, drawn } = recordingCanvas();
    drawCongestion(ctx, net, [], view, at);
    drawCongestion(ctx, net, [], view, at);
    expect(drawn).toEqual([...expected, ...expected]);
  });

  it('samples a road line once, not again each frame, until the road changes', () => {
    const { ctx } = recordingCanvas();
    drawCongestion(ctx, net, [], view, at);
    const sample = vi.spyOn(Polyline.prototype, 'sampleAtInto');
    try {
      for (let frame = 0; frame < 5; frame++) drawCongestion(ctx, net, [], view, at);
      expect(sample).not.toHaveBeenCalled();
      doc.moveNode(c, { x: m(520), y: m(420) });
      net.rebuild();
      drawCongestion(ctx, net, [], view, at);
      expect(sample).toHaveBeenCalled();
      sample.mockClear();
      drawCongestion(ctx, net, [], view, at);
      expect(sample).not.toHaveBeenCalled();
    } finally {
      sample.mockRestore();
    }
  });
});
