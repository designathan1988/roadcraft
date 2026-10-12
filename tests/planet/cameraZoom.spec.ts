import { describe, expect, it } from 'vitest';

import { MAX_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { CameraMotion } from '@view/cameraMotion';
import { installPlanet } from '@render/planet/bend';

// The planet drawn as the game draws it: points carried onto the sphere.
installPlanet();

/**
 * THE WHEEL ZOOMS TO THE PLACE POINTED AT, FROM THE WHOLE GLOBE DOWN (the
 * player, 2026-10-10: from the globe the zoom went to the view's own centre).
 * The ground point under the pointer when the zoom begins is held under it
 * for the whole glide (`Viewport.grab`, Cesium's `handleZoom` picking once).
 * Run with `vitest.planet.config.ts`.
 */
const W = 1600;
const H = 900;

function globe() {
  const r = createIsoRig({ x: 0, y: 0 }, MAX_HALF_HEIGHT * 0.98);
  r.resize(W, H);
  r.setGround(() => 0);
  r.setPerspective(true);
  return r;
}

describe('the wheel on the planet', () => {
  it('holds the ground pointed at from the whole globe to the street, anywhere on the disc', () => {
    let tried = 0;
    for (const f of [0.3, 0.6, 0.85]) {
      for (let k = 0; k < 8; k++) {
        const r = globe();
        const v = r.viewport;
        const motion = new CameraMotion({ view: () => v, size: () => ({ w: W, h: H }), heightUnder: () => 0 });
        const disc = v.toScreen(v.toWorld(W / 2, 0, W, H), W, H);
        const radius = Math.abs(H / 2 - disc.y);
        const at = { x: W / 2 + Math.cos((k * Math.PI) / 4) * radius * f, y: H / 2 + Math.sin((k * Math.PI) / 4) * radius * f };
        const held = v.grab!(at.x, at.y, 0);
        expect(held).not.toBeNull();
        tried++;
        // Notches of the wheel spent over frames, as the game does.
        for (let frame = 0; frame < 400; frame++) {
          if (frame % 6 === 0 && frame < 300) motion.wheel(0.13, at);
          motion.step(1 / 60);
          const s = v.toScreen(held!.world, W, H, held!.height);
          // Exact from the globe down to the rooftops. In the street the
          // camera eases towards level and a point pointed at high on the
          // screen ends a hair under the horizon, where a tenth of a degree
          // moves it metres: held there within a few pixels, never a jump.
          expect(Math.hypot(s.x - at.x, s.y - at.y)).toBeLessThan(v.zoom < 15 ? 1 : 16);
        }
        expect(v.globe ?? 0).toBeLessThan(0.01);
      }
    }
    expect(tried).toBe(24);
  });

  it('over space it zooms about the middle of the view', () => {
    const r = globe();
    const v = r.viewport;
    const motion = new CameraMotion({ view: () => v, size: () => ({ w: W, h: H }), heightUnder: () => 0 });
    expect(v.grab!(20, 20, 0)).toBeNull();
    const middle = v.toWorld(W / 2, H / 2, W, H);
    for (let frame = 0; frame < 60; frame++) {
      if (frame % 6 === 0) motion.wheel(0.13, { x: 20, y: 20 });
      motion.step(1 / 60);
    }
    const s = v.toScreen(middle, W, H);
    expect(Math.hypot(s.x - W / 2, s.y - H / 2)).toBeLessThan(2);
  });
});
