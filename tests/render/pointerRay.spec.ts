import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';

/** The pointer's line of sight (`Viewport.rayAt`) */
const W = 1280;
const H = 720;

function rig(street: boolean) {
  const r = createIsoRig({ x: 0, y: 0 }, 400);
  r.resize(W, H);
  r.setGround(() => 0);
  r.setPerspective(true);
  if (street) for (let i = 0; i < 120; i++) r.viewport.zoomAt(W / 2, H / 2, 1.06, W, H, 0);
  return r.viewport;
}

describe('the pointer ray', () => {
  for (const street of [false, true]) {
    it(`lands on its pixel wherever it goes (${street ? 'street level' : 'overview'})`, () => {
      const v = rig(street);
      for (let py = 10; py < H; py += 70) {
        for (let px = 10; px < W; px += 140) {
          const ray = v.rayAt!(px, py, W, H);
          expect(Math.hypot(ray.dx, ray.dy, ray.dz)).toBeCloseTo(1, 9);
          for (const t of [5, 50, 500]) {
            const p = v.toScreen({ x: ray.ox + ray.dx * t, y: ray.oy + ray.dy * t }, W, H, ray.oz + ray.dz * t);
            expect(Math.hypot(p.x - px, p.y - py)).toBeLessThan(0.5);
          }
        }
      }
    });
  }

  it('starts at the eye, and over the horizon goes up, where the ground plane answers nothing', () => {
    const v = rig(true);
    const eye = v.eye!;
    const ray = v.rayAt!(W / 2, 20, W, H);
    expect(Math.hypot(ray.ox - eye.x, ray.oy - eye.y, ray.oz - eye.z)).toBeLessThan(1e-6);
    expect(ray.dz).toBeGreaterThan(0);
    // The old way's premise gone: the ground plane's "point" under that pixel is not on its line.
    const ground = v.toWorldAt(W / 2, 20, 0, W, H);
    const back = v.toScreen(ground, W, H, 0);
    expect(Math.hypot(back.x - W / 2, back.y - 20)).toBeGreaterThan(50);
  });
});
