import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/** DON'T BLOCK THE BOX, BETWEEN TWO CLOSE JUNCTIONS. */
function closeTees(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 });
  const a = doc.addNode({ x: -25, y: 0 });
  const b = doc.addNode({ x: 25, y: 0 });
  const east = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(west.id, a.id, 2);
  doc.addSegment(a.id, b.id, 2);
  doc.addSegment(b.id, east.id, 2);
  doc.addSegment(doc.addNode({ x: -25, y: 400 }).id, a.id, 1);
  doc.addSegment(doc.addNode({ x: 25, y: -400 }).id, b.id, 1);
  return doc;
}

describe('two signalised junctions a car length apart', () => {
  it('never admits a car it has no room for', () => {
    const sim = simOf(closeTees(), 0x5eed, 2);
    sim.auditEnabled = true;
    let stuckInBox = 0, waitingOutside = 0;
    const still = new Map<number, number>();
    for (let i = 0; i < Math.round(40 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        const inBox = sim.lanelet(v.lanelet)?.kind === 'connector';
        if (!inBox && v.v < 0.2) waitingOutside++;
        const held = inBox && v.v < 0.2 ? (still.get(v.id) ?? 0) + DT : 0;
        still.set(v.id, held);
        // Counted once per vehicle, on the tick it crosses ten seconds.
        if (held >= 10 && held < 10 + DT) stuckInBox++;
      }
    }
    // Cars did queue at the reds (vehicle-ticks stopped outside a junction).
    console.log(`shortLinkBox: ${waitingOutside} waiting vehicle-ticks`);
    expect(waitingOutside).toBeGreaterThan(1000);
    expect(stuckInBox).toBe(0);
    expect(sim.issues.filter((x) => x.code === 'staleClaim')).toEqual([]);
  });
});
