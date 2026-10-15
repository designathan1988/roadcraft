import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { m } from '@world/units';

/** THE CAMERA DOES NOT SHAKE AMONG THE BUILDINGS. */
const W = 1280;
const H = 720;
/** Towers 14 m wide and 40 m tall in a row between the eye and the point looked at, streets of 16 m between them; the eye's floor eases down within 2 m (`cameraSolids.ts`). */
function towers(x: number, y: number): number {
  const period = m(30), wide = m(14), reach = m(2);
  const along = ((x % period) + period) % period;
  const out = Math.max(0, Math.abs(along - period / 2) - wide / 2);
  if (Math.abs(y - m(4)) > m(1) + reach || out >= reach) return -Infinity;
  const t = out / reach;
  return m(41) - m(41) * (t * t * (3 - 2 * t));
}

function street() {
  const rig = createIsoRig({ x: 0, y: 0 }, m(4));
  rig.resize(W, H);
  rig.setGround(() => 0);
  rig.setSolids(towers);
  rig.setPerspective(true);
  // Looking across the towers, from low over the street.
  rig.viewport.setOrbit(-Math.PI / 2, 0.35);
  return rig;
}

describe('the camera among buildings', () => {
  it('does not move for towers a quick drag carries through the sightline', () => {
    const rig = street();
    const step = m(1.5);
    let last = rig.viewport.eye!;
    let worst = 0;
    for (let frame = 0; frame < 240; frame++) {
      rig.viewport.slide(step, 0);
      rig.settle(1 / 60);
      const eye = rig.viewport.eye!;
      worst = Math.max(worst, Math.hypot(eye.x - last.x, eye.y - last.y, eye.z - last.z));
      expect(eye.z).toBeGreaterThanOrEqual(towers(eye.x, eye.y) - 1e-6);
      last = eye;
    }
    // Each frame the drag's own step and a little: no jump of metres.
    expect(worst).toBeLessThan(step * 1.6);
  });

  it('never goes back and forth while a slow drag passes tower after tower', () => {
    const rig = street();
    const reach = (): number => {
      const e = rig.viewport.eye!, c = rig.viewport.centre;
      return Math.hypot(e.x - c.x, e.y - c.y, e.z);
    };
    let last = reach();
    let trend = 0;
    let turns = 0;
    const frames = 1200;
    for (let frame = 0; frame < frames; frame++) {
      rig.viewport.slide(m(0.25), 0);
      rig.settle(1 / 60);
      const now = reach();
      const d = now - last;
      if (Math.abs(d) > 0.01) {
        const sign = Math.sign(d);
        if (trend !== 0 && sign !== trend) turns++;
        trend = sign;
      }
      last = now;
    }
    // Ten towers passed: in and out once each at most, never a shake.
    const passed = (frames * m(0.25)) / m(30);
    expect(turns).toBeLessThanOrEqual(Math.ceil(passed) * 2 + 2);
  });
});
