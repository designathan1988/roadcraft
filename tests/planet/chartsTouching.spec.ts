import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/cubeSphere';
import { FACE_HALF, faceToSphereInto } from '@core/cubeSphere';
import { TILES, TILES_PER_SIDE, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartsTouching, sphereToChartInto } from '@world/planet/charts';

/**
 * WHICH PIECES A ROAD'S SURFACE IS DRAWN BY (`world/planet/charts.ts`
 * `chartsTouching`, `render/roadSurfaces.ts` `spread`). Run with
 * `vitest.planet.config.ts`.
 *
 * Each piece of the planet draws only its own ground; a surface reaching past
 * its piece must be given to every piece it lies on. Found by its vertices, a
 * straight road whose side crossed the corner of a neighbour was never given
 * to it: the asphalt pinched to a point where four pieces meet.
 */

const s: Vec3 = { x: 0, y: 0, z: 0 };

/** The pieces the points of a rectangle (`chart`'s map) lie on, sampled every unit. */
function piecesUnder(chart: number, corners: readonly [number, number][]): Set<number> {
  const c = tileCentre(chart);
  const [a, b, , d] = corners;
  const out = new Set<number>();
  const along = Math.hypot(b![0] - a![0], b![1] - a![1]), across = Math.hypot(d![0] - a![0], d![1] - a![1]);
  for (let i = 0; i <= along; i++) {
    for (let j = 0; j <= across; j++) {
      const u = i / along, v = j / across;
      const x = a![0] + (b![0] - a![0]) * u + (d![0] - a![0]) * v;
      const y = a![1] + (b![1] - a![1]) * u + (d![1] - a![1]) * v;
      tileToSphereInto(chart, x - c.x, y - c.y, s);
      const t = tileOfDirection(s);
      if (t !== chart) out.add(t);
    }
  }
  return out;
}

/** A road 180 units long and 14 wide on `chart`'s map, through `through`, heading `angle`. */
function road(through: { x: number; y: number }, angle: number): [number, number][] {
  const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
  const p = (along: number, side: number): [number, number] =>
    [through.x + dx * along + nx * side, through.y + dy * along + ny * side];
  return [p(-90, -7), p(90, -7), p(90, 7), p(-90, 7)];
}

describe('the pieces a surface reaches', () => {
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  for (const [where, face, i, j] of [
    ['inside a face', 2, 5, 5],
    ['on the edge of a face', 1, 11, 6],
    ['at a corner of the cube', 4, 11, 11],
  ] as const) {
    it(`gives a road through a corner of the pieces to every piece under it, ${where}`, () => {
      const chart = face * TILES_PER_SIDE * TILES_PER_SIDE + j * TILES_PER_SIDE + i;
      expect(TILES[chart]!.face).toBe(face);
      // The piece's corner where it meets its neighbours, on its map.
      faceToSphereInto(face, -FACE_HALF + (i + 1) * step, -FACE_HALF + (j + 1) * step, s);
      const corner = sphereToChartInto(chart, s, { x: 0, y: 0 });
      // Roads through points beside that corner, every 15 degrees.
      for (let k = 0; k < 24; k++) {
        const angle = (k * Math.PI) / 12;
        for (const [ox, oy] of [[-6, -6], [-3, 4], [5, -2]] as const) {
          const corners = road({ x: corner.x + ox, y: corner.y + oy }, angle);
          const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
          const touched = chartsTouching(chart, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), new Set());
          for (const piece of piecesUnder(chart, corners)) {
            expect(touched.has(piece), `piece ${piece} under a road at ${k * 15} degrees`).toBe(true);
          }
        }
      }
    });
  }
});
