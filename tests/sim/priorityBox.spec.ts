import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/** DON'T BLOCK THE BOX AT A JUNCTION WITHOUT SIGNALS EITHER. */
function teesOnAStreet(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 });
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: 120, y: 0 });
  const east = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(west.id, a.id, 1);
  doc.addSegment(a.id, b.id, 1);
  doc.addSegment(b.id, east.id, 1);
  doc.addSegment(doc.addNode({ x: 0, y: 400 }).id, a.id, 0);
  doc.addSegment(doc.addNode({ x: 120, y: -400 }).id, b.id, 0);
  return doc;
}

/** Simulated seconds per seed: enough for the queue to reach back over the junctions (counted below). */
const SECONDS = 60;

describe('two priority junctions close together', () => {
  for (const seed of [1, 3]) {
    it(`never leaves a car standing in a junction behind a queue (seed ${seed})`, () => {
      const sim = simOf(teesOnAStreet(), seed, 2);
      const held = new Map<number, number>();
      let stalls = 0, queued = 0;
      for (let i = 0; i < Math.round(SECONDS / DT); i++) {
        step(sim, { traffic: true, pedestrians: true });
        for (const v of sim.vehicles.values()) {
          const inBox = sim.lanelet(v.lanelet)?.kind === 'connector';
          const behindCar = v.constraints.obstacles.some((o) => o.kind === 'vehicle' && o.gap < 8 && o.speed < 0.5);
          if (behindCar) queued++;
          const t = inBox && v.v < 0.2 && behindCar ? (held.get(v.id) ?? 0) + DT : 0;
          held.set(v.id, t);
          if (t >= 3 && t < 3 + DT) stalls++;
        }
      }
      // The queue the junction must not admit into did form (vehicle-ticks behind a stopped car).
      console.log(`priorityBox seed ${seed}: ${queued} queued vehicle-ticks`);
      expect(queued).toBeGreaterThan(1000);
      expect(stalls).toBe(0);
    });
  }
});
