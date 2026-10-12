import { describe, expect, it } from 'vitest';

import { MAX_HALF_HEIGHT, createIsoRig } from '@render/isoViewport';
import { installPlanet } from '@render/planet/bend';
import { tileCentre } from '@world/planet/atlas';
import { atlasToSphereInto, towardsNorthInto } from '@world/planet/charts';
import { northOnScreen, northTurn } from '@ui/v2/compass';
import { CameraMotion } from '@view/cameraMotion';

installPlanet();

/**
 * THE COMPASS ON THE PLANET (`ui/v2/compass.ts`): the needle points at the
 * planet's north pole, and a click turns the view so north stands straight
 * up the screen, from the street to the whole globe, tilted or not. Run with
 * `vitest.planet.config.ts`.
 */
const W = 1600;
const H = 900;

function rig(at: { x: number; y: number }, half: number, azimuth: number, elevation: number) {
  const r = createIsoRig(at, half);
  r.resize(W, H);
  r.setGround(() => 0);
  r.setPerspective(true);
  r.viewport.setOrbit(azimuth, elevation);
  return r.viewport;
}

describe('the compass on the planet', () => {
  it('points along the ground towards the pole', () => {
    const c = tileCentre(200);
    const p = towardsNorthInto(c.x, c.y, 50, { x: 0, y: 0 });
    const a = atlasToSphereInto(c.x, c.y, { x: 0, y: 0, z: 0 });
    const b = atlasToSphereInto(p.x, p.y, { x: 0, y: 0, z: 0 });
    // Nearer the north pole (planet z), fifty units along the ground.
    expect(b.z).toBeGreaterThan(a.z);
    expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(50, 0);
  });

  it('turns the view to face north, wherever it looks from', () => {
    let tried = 0;
    for (const tile of [17, 200, 431, 700]) {
      for (const half of [MAX_HALF_HEIGHT * 0.98, MAX_HALF_HEIGHT * 0.2, 60]) {
        for (const azimuth of [0.4, 2.2, -1.9]) {
          for (const elevation of [0.5, 1.2]) {
            const c = tileCentre(tile);
            const v = rig({ x: c.x + 37, y: c.y - 21 }, half, azimuth, elevation);
            // Clicked: the view glides round to north, frame by frame.
            const motion = new CameraMotion({ view: () => v, size: () => ({ w: W, h: H }), heightUnder: () => 0 });
            motion.aim(() => northTurn(v, W, H));
            for (let frame = 0; frame < 120 && motion.moving; frame++) motion.step(1 / 60);
            expect(motion.moving).toBe(false);
            expect(Math.abs(northOnScreen(v, W, H))).toBeLessThan(0.02);
            tried++;
          }
        }
      }
    }
    expect(tried).toBe(72);
  });
});
