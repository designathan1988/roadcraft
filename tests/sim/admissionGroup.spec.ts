import { afterEach, describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { admissionProbe } from '@sim/intersections/admission';
import { cycleFull, cyclesOf } from '@sim/intersections/cycles';
import { JAM_GAP } from '@sim/params';
import { simOf } from './support/bodies';

afterEach(() => { admissionProbe.banker = null; });

describe('the ring meter', () => {
  it('reads the cars on the ring as the walk over the fleet did', () => {
    // A ring of short one-way streets with arms: `roundabout.spec`'s kind of town.
    const doc = new RoadDoc();
    const r = 60, n = 6;
    const ring = Array.from({ length: n }, (_, k) => doc.addNode({ x: Math.cos((k / n) * Math.PI * 2) * r, y: Math.sin((k / n) * Math.PI * 2) * r }));
    for (let k = 0; k < n; k++) doc.addSegment(ring[k]!.id, ring[(k + 1) % n]!.id, 1);
    for (let k = 0; k < n; k += 2) {
      const out = doc.addNode({ x: Math.cos((k / n) * Math.PI * 2) * 600, y: Math.sin((k / n) * Math.PI * 2) * 600 });
      doc.addSegment(out.id, ring[k]!.id, 1);
    }
    const sim = simOf(doc, 0x5eed, 2);
    let asked = 0;
    for (let i = 0; i < Math.round(30 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      if (i % 10) continue;
      for (const lane of sim.graph.lanelets.values()) {
        if (lane.kind !== 'connector' || !lane.fromLane || !lane.toLane) continue;
        const need = 4 + JAM_GAP;
        const old = cyclesOf(sim, lane.toLane).some((cycle) => {
          if (cycle.lanelets.has(lane.fromLane!)) return false;
          let used = need;
          for (const v of sim.vehicles.values()) if (cycle.lanelets.has(v.lanelet)) used += v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
          return used > cycle.storage * 0.7;
        });
        expect(cycleFull(sim, lane.fromLane, lane.toLane, need)).toBe(old);
        asked++;
      }
    }
    expect(asked).toBeGreaterThan(100);
  });
});
