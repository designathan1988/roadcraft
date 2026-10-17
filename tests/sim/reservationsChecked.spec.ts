import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/** A VEHICLE'S RESERVATION CHAIN IS WALKED AGAIN ONLY WHEN WHAT IT READS MOVED (`pipeline.ts` reconcileReservedChain, `SimWorld.reservationsChecked`) */
function tees(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 }), a = doc.addNode({ x: 0, y: 0 }), east = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(west.id, a.id, 1);
  doc.addSegment(a.id, east.id, 1);
  doc.addSegment(doc.addNode({ x: 0, y: 400 }).id, a.id, 0);
  return doc;
}

describe('the reservation chains of the traffic', () => {
  it('are kept as found while a vehicle drives on the same lane with the same grant and route', () => {
    const sim = simOf(tees(), 2, 2);
    let kept = 0, walked = 0;
    for (let t = 0; t < Math.round(30 / DT); t++) {
      const before = new Map([...sim.vehicles.values()].map((v) => [v.id, sim.reservationsChecked.get(v)]));
      step(sim, { pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const was = before.get(v.id), now = sim.reservationsChecked.get(v);
        if (!was || !now) continue;
        if (was === now) kept++; else walked++;
      }
    }
    // Most ticks of most vehicles nothing it reads moved: the chain not walked.
    expect(kept + walked).toBeGreaterThan(100);
    expect(kept).toBeGreaterThan(walked);
  });
});
