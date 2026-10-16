import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { addLine, addStop, emptyTransit } from '@world/transit';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { laneBeside } from '@sim/agents/parking';

/** THE BUS STOPS AN EDIT OF THE LANES REACHES, FOUND BY PLACE, STAND WHERE A WHOLE REBUILD PUTS THEM */
const BLOCK = 120;

interface StopLane { readonly lanelet: string; readonly at: number }

describe('the bus stops after an edit of the lanes', () => {
  it('have the lane beside them a whole rebuild finds', () => {
    const doc = new RoadDoc();
    const n = 4;
    const ids: number[][] = [];
    for (let i = 0; i <= n; i++) {
      ids.push([]);
      for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * i, y: m(BLOCK) * j }).id);
    }
    const along: SegmentId[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        if (i < n) { const s = doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1)!; if (j % 2 === 1) along.push(s.id); }
        if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
      }
    }
    // A stop on the footway's edge at the middle of every other east-west street, one line through them all.
    let t = emptyTransit();
    const stops: number[] = [];
    for (const seg of along) {
      const s = doc.segment(seg)!;
      const a = doc.node(s.a)!, b = doc.node(s.b)!;
      const stop = addStop(t, { mode: 'bus', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - m(6), segment: seg });
      t = stop.data;
      stops.push(stop.id);
    }
    t = addLine(t, 'bus', stops).data;
    doc.setTransit(t);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x5709);
    w.rebuildTopology();
    w.clock.paused = false;
    const lanes = (): Map<number, StopLane> => (w.city.transit as unknown as { stopLanes: Map<number, StopLane> }).stopLanes;
    const check = (): void => {
      for (const s of w.doc.transit.stops) {
        const whole = laneBeside(w, s.x, s.y, s.segment);
        const kept = lanes().get(s.id);
        expect(kept ? { lanelet: kept.lanelet, at: kept.at } : null, `stop ${s.id}`).toEqual(whole ? { lanelet: whole.lanelet, at: whole.at } : null);
      }
    };
    for (let i = 0; i < 5; i++) step(w, { traffic: false, pedestrians: false });
    expect(lanes().size).toBeGreaterThan(1);
    check();
    // The street of one stop taken away, and another street drawn across one; then a stop's street put back.
    const taken = doc.segment(along[1]!)!;
    doc.removeSegment(along[1]!);
    net.rebuild();
    for (let i = 0; i < 3; i++) step(w, { traffic: false, pedestrians: false });
    check();
    const far = doc.segment(along[along.length - 1]!)!;
    const x = (doc.node(far.a)!.x + doc.node(far.b)!.x) / 2 + m(20);
    doc.addSegment(doc.addNode({ x, y: doc.node(far.a)!.y - m(40) }).id, doc.addNode({ x, y: doc.node(far.a)!.y + m(40) }).id, 1);
    doc.addSegment(taken.a, taken.b, 1);
    net.rebuild();
    for (let i = 0; i < 3; i++) step(w, { traffic: false, pedestrians: false });
    check();
  });
});
