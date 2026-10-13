import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { step } from '@sim/pipeline';
import { DT, MAX_LATERAL_ACCEL } from '@sim/params';
import { comfortableLateral, curveSpeedCap } from '@sim/vehicles/curvature';
import type { SimWorld } from '@sim/world';
import { fixtureDoc, simOf } from './support/bodies';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/**
 * A BEND IS TAKEN AT A SPEED A DRIVER WOULD TAKE IT.
 *
 * Nothing used to slow a vehicle for the curvature of the road: a turn at a
 * junction took a fixed share of the limit and a curved street took none.
 * Measured before this, on a single bend of an urban street, vehicles pulled
 * 10.3 m/s² sideways, and on the saved player map 22 m/s² - more than twice
 * what a tyre holds - with 1 % of all samples over 1 g.
 */

/** Curvature of a lanelet at `s`, over the same kind of chord a driver reads. */
function curvatureAt(sim: SimWorld, lanelet: string, s: number): number {
  const lane = sim.lanelet(lanelet);
  if (!lane) return 0;
  const h = Math.min(6 * U, lane.length / 2);
  const at = Math.min(Math.max(s, h), lane.length - h);
  const a = lane.centre.sampleAt(at - h).t;
  const b = lane.centre.sampleAt(at + h).t;
  return Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) / (2 * h);
}

function bendDoc(): RoadDoc {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600 * U, y: 0 });
  const b = doc.addNode({ x: 0, y: 0 });
  const c = doc.addNode({ x: 300 * U, y: 300 * U });
  const d = doc.addNode({ x: 300 * U, y: 900 * U });
  doc.addSegment(a.id, b.id, 2);
  const bend = doc.addSegment(b.id, c.id, 2)!;
  doc.setSegmentCurve(bend.id, { t: 0.5, h: -160 * U });
  doc.addSegment(c.id, d.id, 2);
  return doc;
}

describe('curvature speed', () => {
  it('keeps the sideways pull of every bend within what a driver accepts', () => {
    // The sideways pull as a share of what THIS driver accepts at THIS speed
    // (the figure falls with speed, `MAX_LATERAL_ACCEL`), plus what the chord
    // estimate and one step of lag add; and never beyond the most anybody
    // accepts at a crawl. The share is read against the speed AFTER the step,
    // one step later than the cap was set from, which is worth a few per cent.
    const ceiling = 1.4;
    const absolute = MAX_LATERAL_ACCEL * 1.2 * 1.35;
    for (const [name, doc] of [['bend', bendDoc()], ['player-map', fixtureDoc()]] as const) {
      const sim = simOf(doc, 5, 1);
      let worst = 0;
      let worstAbsolute = 0;
      let inBend = 0;
      sim.clock.run(Math.round(40 / DT), () => {
        step(sim, { traffic: true, pedestrians: false });
        for (const v of sim.vehicles.values()) {
          const k = curvatureAt(sim, v.lanelet, v.s - v.archetype.length / 2);
          if (k > 0.002 / U) inBend++;
          worst = Math.max(worst, (v.v * v.v * k) / comfortableLateral(v, v.v));
          worstAbsolute = Math.max(worstAbsolute, v.v * v.v * k);
        }
      });
      expect(inBend, name).toBeGreaterThan(1000);
      expect(worst, name).toBeLessThan(ceiling);
      expect(worstAbsolute, name).toBeLessThan(absolute);
    }
  });

  it('brakes for a bend before it, never all at once at its entry', () => {
    const sim = simOf(bendDoc(), 5, 2);
    let worstBraking = 0;
    let worstOverCap = 0;
    let braked = 0;
    sim.clock.run(Math.round(60 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const cap = curveSpeedCap(sim, v);
        if (cap >= v.v) continue;
        braked++;
        // Braking for the bend, a driver never brakes harder than comfortably
        // (IDM's b): the bend was seen in time. The speed follows the cap
        // through the jerk-limited controller (`drive/physicalMotion.ts`), a
        // step or two behind - so the gap to the cap is small, not zero.
        worstBraking = Math.max(worstBraking, -v.accel - v.driver.b);
        worstOverCap = Math.max(worstOverCap, (v.v - cap) / m(1));
      }
    });
    expect(braked).toBeGreaterThan(0);
    expect(worstBraking).toBeLessThan(0.5);
    expect(worstOverCap).toBeLessThan(0.25);
  });

  it('leaves a straight road alone and gives heavy vehicles a gentler limit', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -800 * U, y: 0 });
    const b = doc.addNode({ x: 800 * U, y: 0 });
    doc.addSegment(a.id, b.id, 2);
    const sim = simOf(doc, 5, 1);
    sim.clock.run(Math.round(40 / DT), () => step(sim, { traffic: true, pedestrians: false }));
    let checked = 0;
    for (const v of sim.vehicles.values()) {
      checked++;
      expect(curveSpeedCap(sim, v)).toBe(Infinity);
      const heavy = v.archetype.length > 20 * U;
      if (heavy) expect(comfortableLateral(v)).toBeLessThan(MAX_LATERAL_ACCEL * 1.2 * 0.71);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
