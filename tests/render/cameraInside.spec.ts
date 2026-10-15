import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { m } from '@world/units';

/** THE VIEW DRAGGED ONTO A TOWER: the eye and the point it looks at both inside one building. */
const W = 1280;
const H = 720;
const HALF = m(40), TALL = m(60), REACH = m(2), CLEAR = m(1);
/** A tower 80 m square and 60 m tall round the origin, as `cameraSolids.ts` files it. */
function floorAt(x: number, y: number): number {
  const out = Math.hypot(Math.max(0, Math.abs(x) - HALF), Math.max(0, Math.abs(y) - HALF));
  if (out >= REACH) return -Infinity;
  const t = out / REACH;
  return TALL + CLEAR - (TALL + CLEAR) * (t * t * (3 - 2 * t));
}
const roofAt = (x: number, y: number): number => (Math.abs(x) <= HALF && Math.abs(y) <= HALF ? TALL : -Infinity);

function onTower(withRoof: boolean) {
  const rig = createIsoRig({ x: 0, y: 0 }, m(4));
  rig.resize(W, H);
  rig.setGround(() => 0);
  rig.setSolids(floorAt, withRoof ? roofAt : null);
  rig.setPerspective(true);
  rig.viewport.setOrbit(0.8, 0.1);
  return rig;
}

describe('the view set on a tower', () => {
  it('looks across the roof, not down into it', () => {
    const rig = onTower(true);
    const eye = rig.viewport.eye!;
    expect(eye.z).toBeGreaterThanOrEqual(floorAt(eye.x, eye.y) - 1e-6);
    const ray = rig.viewport.rayAt!(W / 2, H / 2, W, H);
    // Its own tilt, a little down: not straight into the roof under the eye.
    expect(ray.dz).toBeGreaterThan(-0.5);
    // The roof the centre of the view meets is well ahead of the eye.
    const t = (TALL - ray.oz) / ray.dz;
    expect(t).toBeGreaterThan(m(3));
  });

  it('brings the eye out through the wall when the point looked at is by the wall, outside', () => {
    // The point in the margin a metre past the east wall, the eye behind it in the tower.
    const rig = createIsoRig({ x: HALF + m(1), y: 0 }, m(4));
    rig.resize(W, H);
    rig.setGround(() => 0);
    rig.setSolids(floorAt, roofAt);
    rig.setPerspective(true);
    rig.viewport.setOrbit(Math.PI, 0.1);
    const eye = rig.viewport.eye!;
    expect(roofAt(eye.x, eye.y)).toBe(-Infinity);
    // At the street, not up the tower over its roof.
    expect(eye.z).toBeLessThan(m(10));
  });

  it('keeps the eye out of a tower and its podium wherever the view is set', () => {
    // A podium 40 m wide and 30 m tall on the tower's east side (as the default town's corner tower stands).
    const boxes = [{ x0: -HALF, x1: HALF, y0: -HALF, y1: HALF, top: TALL }, { x0: HALF, x1: HALF + m(40), y0: -HALF, y1: HALF, top: m(30) }];
    const roofs = (x: number, y: number): number => {
      let r = -Infinity;
      for (const q of boxes) if (x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1) r = Math.max(r, q.top);
      return r;
    };
    const floors = (x: number, y: number): number => {
      let f = -Infinity;
      for (const q of boxes) {
        const out = Math.hypot(Math.max(0, q.x0 - x, x - q.x1), Math.max(0, q.y0 - y, y - q.y1));
        if (out >= REACH) continue;
        const t = out / REACH;
        f = Math.max(f, q.top + CLEAR - (q.top + CLEAR) * (t * t * (3 - 2 * t)));
      }
      return f;
    };
    let lookedDown = 0;
    for (const tx of [m(-50), m(-30), m(0), m(39), m(41), m(60), m(85)]) {
      for (const az of [0, 0.8, 1.6, 2.4, Math.PI, 4.0, 5.5]) {
        const rig = createIsoRig({ x: tx, y: m(5) }, m(4));
        rig.resize(W, H);
        rig.setGround(() => 0);
        rig.setSolids(floors, roofs);
        rig.setPerspective(true);
        rig.viewport.setOrbit(az, 0.1);
        const eye = rig.viewport.eye!;
        expect(eye.z).toBeGreaterThanOrEqual(roofs(eye.x, eye.y) - 1e-6);
        if (rig.viewport.rayAt!(W / 2, H / 2, W, H).dz < -0.9) lookedDown++;
      }
    }
    // Never straight down into a roof a metre under the eye, as the grey screen did.
    expect(lookedDown).toBe(0);
  });

  it('looked down into the roof with the eye lifted alone (the defect)', () => {
    const ray = onTower(false).viewport.rayAt!(W / 2, H / 2, W, H);
    expect(ray.dz).toBeLessThan(-0.9);
  });
});
