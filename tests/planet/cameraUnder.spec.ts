import { describe, expect, it } from 'vitest';

import { createIsoRig } from '@render/isoViewport';
import { installPlanet } from '@render/planet/bend';
import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES_PER_SIDE, TILE_INNER } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { atlasToSphereInto } from '@world/planet/charts';

/**
 * THE GROUND UNDER THE PLANET CAMERA'S EYE (`render/isoViewport.ts` `apply`,
 * `planet/bend.ts` `planetUnderInto`).
 *
 * The perspective camera is kept over the ground under it and pulled in front
 * of buildings along its line of sight. Both were read at the camera's own
 * three.js x, z taken as an atlas point: away from the point looked at that
 * point lies in another cell of the atlas - another piece, not a neighbour on
 * the sphere - and the eye was lifted by, or pulled in front of, ground and
 * buildings kilometres away (the player: "navegação ruim e ruidosa"). The
 * ground is now read where the planet is drawn under the eye.
 * Run with `vitest.planet.config.ts`.
 */
const W = 1600;
const H = 900;

// A piece at the east end of its row of the atlas (column 11): the next cell
// east in the atlas (column 12) is a piece some 5 km away on the sphere.
const piece = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 3 * TILES_PER_SIDE + (TILES_PER_SIDE - 1);
const centre = tileCentre(piece);
const at = { x: centre.x + TILE_INNER - 10, y: centre.y };

const home: Vec3 = { x: 0, y: 0, z: 0 };
atlasToSphereInto(at.x, at.y, home);
const s: Vec3 = { x: 0, y: 0, z: 0 };
/** Flat near the point looked at; a plateau higher than the eye on anything more than 3 km round the sphere from it. */
const trap = (x: number, y: number): number => {
  atlasToSphereInto(x, y, s);
  const arc = Math.acos(Math.min(1, s.x * home.x + s.y * home.y + s.z * home.z)) * PLANET_RADIUS;
  return arc > 3000 ? 6000 : 0;
};

function eyeOver(ground: (x: number, y: number) => number, tilt: number, halfHeight: number): number {
  const r = createIsoRig(at, halfHeight, { azimuth: 0, elevation: (tilt * Math.PI) / 180 });
  r.resize(W, H);
  r.setGround(ground);
  r.setPerspective(true);
  r.viewport.setOrbit(0, (tilt * Math.PI) / 180);
  return r.viewport.eye!.z;
}

describe('the planet camera stands over the ground under it', () => {
  installPlanet();
  for (const tilt of [20, 35, 60]) {
    // From 900 the eye stands past the cell of the point looked at in the atlas,
    // its own ground still within 3 km round the sphere (at 1 300 it is 4.4 km off).
    for (const halfHeight of [80, 300, 900, 1000]) {
      it(`tilt ${tilt}, half-height ${halfHeight}: not lifted by ground far away on the sphere`, () => {
        // The same view over ground flat everywhere: the eye must stand as there.
        expect(Math.abs(eyeOver(trap, tilt, halfHeight) - eyeOver(() => 0, tilt, halfHeight))).toBeLessThan(0.01);
      });
    }
  }
});
