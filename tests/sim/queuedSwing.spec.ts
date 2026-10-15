import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { collisions, simOf } from './support/bodies';

/** A BUS TURNING OFF A SHORT LINK, AND THE CAR WAITING BESIDE IT. */
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

describe('a long vehicle turning off a short link', () => {
  for (const seed of [2, 12]) {
    it(`never lays its body over a car waiting in the next lane (seed ${seed})`, () => {
      const sim = simOf(closeTees(), seed, 2);
      let overlaps = 0;
      for (let i = 0; i < Math.round(40 / DT); i++) {
        step(sim, { traffic: true, pedestrians: true });
        if (i % 5 === 0) overlaps += collisions(sim).length;
      }
      expect(overlaps).toBe(0);
    });
  }
});
