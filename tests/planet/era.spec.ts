import { describe, expect, it } from 'vitest';
import { FACE_HALF, faceToSphereInto } from '@core/cubeSphere';
import { TILES_PER_SIDE, tileOfDirection } from '@core/planetTiles';
import { RoadDoc } from '@world/doc';
import { sphereToChartInto } from '@world/planet/charts';
import { quarterOf } from '@editor/zoning';

/**
 * A BUILDING'S QUARTER ON THE PLANET (`editor/zoning.ts` quarterOf). Run with
 * `vitest.planet.config.ts`.
 *
 * Its cells were cut in the atlas's coordinates: a quarter across a border
 * between two pieces was two quarters (an old row of houses facing a new
 * one), and the old middle of the town was the atlas's origin, a piece
 * like any other. The cells are now the cube face's own.
 */
describe("a building's quarter on the planet", () => {
  it('is one quarter whichever piece it is read on', () => {
    const doc = new RoadDoc();
    const step = (2 * FACE_HALF) / TILES_PER_SIDE;
    for (const y of [-887, 37, 411]) {
      for (const dx of [-3, -1, 2]) {
        const d = faceToSphereInto(2, -FACE_HALF + 6 * step + dx, y, { x: 0, y: 0, z: 0 });
        const here = tileOfDirection(d);
        const there = tileOfDirection(faceToSphereInto(2, -FACE_HALF + 6 * step + dx + (dx < 0 ? 10 : -10), y, { x: 0, y: 0, z: 0 }));
        expect(there).not.toBe(here);
        const a = sphereToChartInto(here, d, { x: 0, y: 0 });
        const b = sphereToChartInto(there, d, { x: 0, y: 0 });
        expect(quarterOf(a, { x: 0, y: 1 }, doc)).toEqual(quarterOf(b, { x: 0, y: 1 }, doc));
      }
    }
  });
});
