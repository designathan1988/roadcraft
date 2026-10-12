import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, toOwner } from '@world/planet/charts';
import { anchorPlanet, installPlanet, planetEye, planetSphereInView } from '@render/planet/bend';

/**
 * WHAT IS CULLED ONE BY ONE ON THE PLANET (`render/planet/bend.ts`
 * planetSphereInView: the plants' and the street furniture's instances, the
 * grass, each vehicle and person). Run with `vitest.planet.config.ts`.
 *
 * Their spheres were tested as the world is built, flat: a thing kept on the
 * chart of the next piece lies 1 600 units or more from the one looked from
 * in the flat world, out of every frustum - benches, lamps, trees and cars
 * across a border were never drawn.
 */

describe('culling where the planet draws a thing', () => {
  it('keeps what stands across a border in view, and drops what is round the back', () => {
    installPlanet();
    // Over an edge of the cube: west of the second piece of face 3.
    const chart = 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1;
    const c = tileCentre(chart);
    const shift = borderShift(chart, -1, 0);
    const look = toOwner(chart, { x: c.x - 200 * U - shift, y: c.y });
    const across = toOwner(chart, { x: c.x - 290 * U - shift, y: c.y + 5 * U });
    expect(chartAt(across.x, across.y)).not.toBe(chartAt(look.x, look.y));
    anchorPlanet(look.x, -look.y);
    const camera = new PerspectiveCamera(50, 16 / 9, 0.5 * U, 20000 * U);
    // Up over the place looked at, looking west along the ground to the border.
    camera.position.set(look.x + 40 * U, 60 * U, -look.y);
    camera.lookAt(look.x - 60 * U, 0, -look.y);
    camera.updateMatrixWorld();
    planetEye(camera.position);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const near = new Sphere(new Vector3(across.x, U, -across.y), U);
    // As it stands in the flat world it is out of view...
    expect(frustum.intersectsSphere(near)).toBe(false);
    // ...and where the planet draws it, in.
    expect(planetSphereInView(frustum, near)).toBe(true);
    // The far side of the planet is behind the horizon, whatever the frustum says.
    const opposite = 5 * TILES_PER_SIDE * TILES_PER_SIDE + 6 * TILES_PER_SIDE + 6;
    const back = tileCentre(opposite);
    expect(planetSphereInView(frustum, new Sphere(new Vector3(back.x, U, -back.y), U))).toBe(false);
  });
});

describe('the plates of ground past the horizon', () => {
  // At the globe the plates' bounding spheres, a plate's width over the
  // ground, kept some 640 of the 864 plates drawn - out to 120 degrees round
  // from under the eye. Tested as the caps of the sphere they cover
  // (`PlanetCap`), only those that can show are drawn, and none that shows is
  // left out.
  it('draws every plate any part of which shows, and few that do not', async () => {
    const { Mesh, PlaneGeometry, Scene, MeshBasicMaterial } = await import('three');
    const { PLANET_RADIUS } = await import('@core/cubeSphere');
    const { TILES, TILE_COUNT } = await import('@core/planetTiles');
    const { TILE_PLATE_HALF } = await import('@world/planet/atlas');
    const { planetCentre, planetPointInto, planetScene, setPlanetGroundFloor } = await import('@render/planet/bend');
    installPlanet();
    const scene = new Scene();
    planetScene(scene);
    setPlanetGroundFloor(0);
    const home = tileCentre(0);
    anchorPlanet(home.x, -home.y);
    const camera = new PerspectiveCamera(35, 16 / 9, 1, 100 * PLANET_RADIUS);
    camera.position.set(home.x, 6 * PLANET_RADIUS, -home.y);
    camera.lookAt(home.x, -PLANET_RADIUS, -home.y);
    camera.updateMatrixWorld();
    planetEye(camera.position);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const geometry = new PlaneGeometry(2 * TILE_PLATE_HALF, 2 * TILE_PLATE_HALF, 1, 1).rotateX(-Math.PI / 2);
    const material = new MeshBasicMaterial();
    const centre = planetCentre(new Vector3());
    const toEye = camera.position.clone().sub(centre);
    const p = new Vector3();
    // Pretend the world is being drawn (`planetScene`): culling on the planet applies.
    scene.onBeforeRender(null as never, scene, camera, null as never, null as never, null as never);
    let drawn = 0, drawnBySphere = 0, wronglyCulled = 0;
    for (let face = 0; face < TILE_COUNT; face++) {
      const c = tileCentre(face);
      const plate = new Mesh(geometry, material);
      plate.position.set(c.x, 0, -c.y);
      plate.updateMatrixWorld();
      if (frustum.intersectsObject(plate)) drawnBySphere++;
      plate.userData['planetCap'] = { dir: TILES[face]!.centre, reach: TILE_PLATE_HALF * Math.SQRT2, top: 0 };
      const kept = frustum.intersectsObject(plate);
      if (kept) drawn++;
      // Does any of it show? A point of the sphere shows when it is in front of the horizon plane.
      let shows = false;
      for (let i = 0; i <= 8 && !shows; i++) {
        for (let j = 0; j <= 8 && !shows; j++) {
          planetPointInto(c.x + (i / 4 - 1) * TILE_PLATE_HALF, 0, -c.y + (j / 4 - 1) * TILE_PLATE_HALF, p);
          shows = p.sub(centre).dot(toEye) > PLANET_RADIUS * PLANET_RADIUS;
        }
      }
      if (shows && !kept) wronglyCulled++;
    }
    scene.onAfterRender(null as never, scene, camera, null as never, null as never, null as never);
    expect(wronglyCulled).toBe(0);
    // About half the planet faces the eye from six radii up.
    expect(drawn).toBeLessThan(0.62 * TILE_COUNT);
    // The bounding spheres kept 647 (2026-10-10); the caps 450.
    expect(drawn).toBeLessThan(0.75 * drawnBySphere);
  });
});
