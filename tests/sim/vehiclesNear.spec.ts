import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { vehiclePose } from '@sim/pose';
import type { Vehicle } from '@sim/vehicles/state';

/** THE VEHICLES NEAR A PLACE, BY THE LANES THERE, ARE THOSE A WALK OVER THE FLEET FINDS */
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
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, j % 3 === 0 ? 3 : 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, i % 3 === 0 ? 3 : 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

describe('the vehicles near a place', () => {
  it('are, within the reach, those of the whole fleet', () => {
    const doc = town(6);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x4ea2);
    w.rebuildTopology();
    w.trafficCount = 120;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    w.clock.paused = false;
    let compared = 0;
    for (let t = 1; t <= 360; t++) {
      step(w, { traffic: true, pedestrians: false });
      if (t % 60 !== 0) continue;
      for (const reach of [m(40), m(120), m(320)]) {
        for (let gx = -4; gx <= 4; gx++) {
          for (let gy = -4; gy <= 4; gy++) {
            const x = gx * m(90), y = gy * m(90);
            const within = (vs: Iterable<Vehicle>): number[] => {
              const out: number[] = [];
              for (const v of vs) {
                const pose = vehiclePose(w, v, 1);
                if (pose && Math.hypot(pose.p.x - x, pose.p.y - y) < reach) out.push(v.id);
              }
              return out.sort((a, b) => a - b);
            };
            const all = within(w.vehicles.values());
            expect(within(w.vehiclesNear(x, y, reach)), `${x},${y} within ${reach}`).toEqual(all);
            compared += all.length;
          }
        }
      }
    }
    expect(w.vehicles.size).toBeGreaterThan(60);
    expect(compared).toBeGreaterThan(1000);
  });
});
