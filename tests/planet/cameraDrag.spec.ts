import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';

import { MAX_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { installPlanet, planetMotion } from '@render/planet/bend';
import { U } from './_border';

installPlanet();

/**
 * THE GLOBE TURNS UNDER THE HAND, SMOOTHLY (the player, 2026-10-10: "dá
 * solavanco, dá travada, muda de região abruptamente"). A drag turns the
 * camera round the planet's centre by the least turn taking the ground under
 * the pointer to the ground grabbed (Cesium's `pan3D`), never across the map
 * of a piece: there the view jumped 20-50 degrees a frame. Steps of a few
 * pixels turn the camera by a few tenths of a degree, the same every step,
 * across every piece the drag crosses, and the ground grabbed stays under
 * the pointer. Run with `vitest.planet.config.ts`.
 */
const W = 1600;
const H = 900;

function rig(halfHeight: number) {
  const r = createIsoRig({ x: 0, y: 0 }, halfHeight);
  r.resize(W, H);
  r.setGround(() => 0);
  r.setPerspective(true);
  return r;
}

/** The camera's direction from the planet's centre, in the planet's own frame. */
function eyeDirection(r: ReturnType<typeof rig>): Vector3 {
  const cam = r.camera;
  cam.updateMatrixWorld(true);
  return cam.position.clone().applyMatrix4(planetMotion().clone().invert()).normalize();
}

describe('a drag over the planet', () => {
  for (const [name, half] of [['the globe', MAX_HALF_HEIGHT * 0.98], ['half way down', MAX_HALF_HEIGHT * 0.25], ['a region', MAX_HALF_HEIGHT * 0.05]] as const) {
    it(`turns ${name} evenly under the hand, the ground held under the pointer`, () => {
      const r = rig(half);
      const v = r.viewport;
      let at = { x: W / 2 - 150, y: H / 2 };
      const held = v.grab!(at.x, at.y, 0)!;
      expect(held).not.toBeNull();
      let before = eyeDirection(r);
      const steps: number[] = [];
      // Right and back again, then down: 4 px a move, as a mouse sends them.
      const path: [number, number][] = [];
      for (let i = 0; i < 75; i++) path.push([4, 0]);
      for (let i = 0; i < 75; i++) path.push([-4, 0]);
      // (Down 120 px: still on the disc - its radius is 200 px at the globe.)
      for (let i = 0; i < 30; i++) path.push([0, 4]);
      for (const [dx, dy] of path) {
        at = { x: at.x + dx, y: at.y + dy };
        v.panTo(held.world, at.x, at.y, W, H, held.height);
        const now = eyeDirection(r);
        steps.push(Math.acos(Math.min(1, before.dot(now))));
        before = now;
        const s = v.toScreen(held.world, W, H, held.height);
        expect(Math.hypot(s.x - at.x, s.y - at.y)).toBeLessThan(0.01);
      }
      const sorted = steps.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      expect(median).toBeGreaterThan(0);
      // No step more than twice the usual one: no jump anywhere on the way.
      expect(Math.max(...steps)).toBeLessThan(median * 2);
    });
  }

  it('slides the globe by exactly the arc asked, whichever way and however far', () => {
    const r = rig(MAX_HALF_HEIGHT * 0.98);
    const v = r.viewport;
    for (const [right, forward] of [[100, 0], [0, 1000], [3000, 3000], [-5000, 0], [0, -20000]] as const) {
      const a = eyeDirection(r);
      // In 0.4 m units, times U: the same arcs at any unit.
      v.slide(right * U, forward * U);
      const b = eyeDirection(r);
      expect(Math.acos(Math.min(1, a.dot(b)))).toBeCloseTo(Math.hypot(right, forward) * U / PLANET_RADIUS, 4);
    }
  });
});
