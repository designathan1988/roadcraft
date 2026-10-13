import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { m } from '@world/units';

/**
 * THE CAMERA DOES NOT SHAKE AMONG THE BUILDINGS. Close up, the eye was
 * pulled in front of any building that came between it and the point looked
 * at; as a drag carried a tower's corner into the sightline the eye jumped
 * 7.8 m in a frame (the player, 2026-10-13: "a câmera fica tripidando").
 * A steady drag along a row of towers between the eye and the point looked
 * at moves the eye with the drag - never more in a frame than the drag and
 * a little - and never into a building.
 */
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

describe('the camera among buildings', () => {
  it('moves smoothly while a drag carries its sightline across roof after roof', () => {
    const rig = createIsoRig({ x: 0, y: 0 }, m(4));
    rig.resize(W, H);
    rig.setGround(() => 0);
    rig.setSolids(towers);
    rig.setPerspective(true);
    // Looking across the towers, from low over the street.
    rig.viewport.setOrbit(-Math.PI / 2, 0.35);
    const step = m(0.25);
    let last = rig.viewport.eye!;
    let worst = 0;
    for (let frame = 0; frame < 600; frame++) {
      rig.viewport.slide(step, 0);
      const eye = rig.viewport.eye!;
      worst = Math.max(worst, Math.hypot(eye.x - last.x, eye.y - last.y, eye.z - last.z));
      // Never inside a tower.
      expect(eye.z).toBeGreaterThanOrEqual(towers(eye.x, eye.y) - 1e-6);
      last = eye;
    }
    // A frame's move: the drag's step and a fraction of the eye's distance, never a jump of metres.
    expect(worst).toBeLessThan(step * 4);
  });
});
