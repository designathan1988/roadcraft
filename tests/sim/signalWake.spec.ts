import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step, tickWork } from '@sim/pipeline';

/** AN EDIT WAKES THE SIGNALS IT REACHED, NOT EVERY SIGNAL OF THE MAP */
const BLOCK = 120;

function town(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 3);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 3);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  return doc;
}

/** The signals stage 1 stepped in one tick. */
function stepped(w: SimWorld): number {
  const before = tickWork.controllers;
  step(w, { traffic: true, pedestrians: false });
  return tickWork.controllers - before;
}

describe('the sleeping signals', () => {
  it('stay asleep through an edit that reaches none of them', () => {
    const doc = town(6);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x51e9);
    w.rebuildTopology();
    w.trafficCount = 6;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    w.clock.paused = false;
    for (let i = 0; i < 300; i++) step(w, { traffic: true, pedestrians: false });
    const signals = w.signalisedControllers().length;
    const awake = stepped(w);
    expect(signals).toBeGreaterThan(20);
    expect(awake).toBeLessThan(signals / 2);
    // A road of its own well off the town: no junction of it built again, no signal near it.
    const x = m(BLOCK) * 8;
    doc.addSegment(doc.addNode({ x, y: 0 }).id, doc.addNode({ x: x + m(60), y: 0 }).id, 1);
    net.rebuild();
    expect(stepped(w)).toBeLessThanOrEqual(awake + 2);
  });
});
