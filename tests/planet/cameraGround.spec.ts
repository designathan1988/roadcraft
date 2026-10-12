import { describe, expect, it } from 'vitest';

import { MIN_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { TILE_HALF, TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';

/**
 * THE PLANET'S CAMERA BROUGHT DOWN TO THE GROUND (the player, 2026-10-10):
 * zoomed in and zoomed on, the picture turned upside down - the ground on
 * top, the sky below - and the view walked on past the closest zoom. The
 * zoom stops at a person's eyes and the sky stays up at every tilt, on a
 * piece's middle, over hills and at a piece's border.
 * Run with `vitest.planet.config.ts`.
 */
const W = 1600;
const H = 900;

const hills = (x: number, y: number): number => 30 * Math.sin(x / 90) * Math.cos(y / 70) + 40;

function rig(at: { x: number; y: number }, ground: (x: number, y: number) => number) {
  const r = createIsoRig(at, 300);
  r.resize(W, H);
  r.setGround(ground);
  r.setPerspective(true);
  return r;
}

const piece = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const middle = tileCentre(piece);
const border = { x: middle.x + TILE_HALF - 3, y: middle.y + 10 };

describe('the planet camera zoomed in to the ground', () => {
  for (const [name, at, ground] of [
    ['a piece\'s middle, flat', middle, () => 0],
    ['a piece\'s middle, over hills', middle, hills],
    ['a piece\'s border, over hills', border, hills],
  ] as const) {
    for (const tilt of [20, 48, 80]) {
      for (const pointer of [{ x: W / 2, y: H / 2 }, { x: W * 0.6, y: H * 0.25 }, { x: W * 0.3, y: H * 0.8 }]) {
        it(`${name}, tilt ${tilt}, pointer ${pointer.x},${pointer.y}: stops at the eyes with the sky up`, () => {
          const r = rig(at, ground);
          const v = r.viewport;
          v.setOrbit(v.azimuth, (tilt * Math.PI) / 180);
          for (let i = 0; i < 200; i++) {
            v.zoomAt(pointer.x, pointer.y, 1.15, W, H, ground(v.centre.x, v.centre.y));
            const e = r.camera.matrixWorld.elements;
            // The camera's up never points down the local radial up, and has no roll.
            expect(e[5]).toBeGreaterThanOrEqual(-1e-9);
            expect(Math.abs(e[1]!)).toBeLessThan(1e-6);
          }
          expect(v.zoom).toBeCloseTo(H / (MIN_HALF_HEIGHT * 2), 6);
          // Zoomed on: nothing moves any more.
          const c = v.centre;
          const eye = v.eye!;
          for (let i = 0; i < 30; i++) v.zoomAt(pointer.x, pointer.y, 1.5, W, H, ground(v.centre.x, v.centre.y));
          expect(Math.hypot(v.centre.x - c.x, v.centre.y - c.y)).toBe(0);
          expect(Math.hypot(v.eye!.x - eye.x, v.eye!.y - eye.y, v.eye!.z - eye.z)).toBe(0);
          // The eye stands over the ground under it.
          expect(v.eye!.z).toBeGreaterThan(ground(v.eye!.x, v.eye!.y));
        });
      }
    }
  }
});
