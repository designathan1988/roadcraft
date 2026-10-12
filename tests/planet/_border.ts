import { FACE_HALF } from '@core/cubeSphere';
import { TUNED_UNIT, m } from '@world/units';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, toOwner } from '@world/planet/charts';

/**
 * Places near a piece's border, for the planet's specs. They were chosen on a
 * planet of faces of 3 000 units of 0.4 m (1 200 m); the pieces are the same
 * angles of the sphere at any size, so a border stands `SIZE` times farther
 * from its piece's centre now. The scenes' lengths are in those units of
 * 0.4 m: times `U` (`TUNED_UNIT`), they are the same metres at any unit. `nearBorder` moves a place the way the border moved -
 * the scene keeps every length (a road, a wall, a building) and stands at the
 * same distance from the border as it was written for.
 */
const SIZE = FACE_HALF / m(1200);

/** The 0.4 m unit the scenes were written in: their lengths times U. */
export const U = TUNED_UNIT;

/** How far out from a piece's centre, along (ux, uy) on its own map, its border lies. */
export function borderAlong(chart: number, ux: number, uy: number): number {
  const c = tileCentre(chart);
  const l = Math.hypot(ux, uy);
  for (let t = 0; t < 20_000; t += 0.25) {
    const p = toOwner(chart, { x: c.x + (ux / l) * t, y: c.y + (uy / l) * t });
    if (chartAt(p.x, p.y) !== chart) return t;
  }
  return Infinity;
}

/** How far (in units) to move a place written for the old planet along (ux, uy) so it keeps its distance to the border. */
export function borderShift(chart: number, ux: number, uy: number): number {
  return borderAlong(chart, ux, uy) * (1 - 1 / SIZE);
}

/**
 * For a scene written to cross SEVERAL borders along (ux, uy): its distances
 * from the piece's centre, written for the old planet, moved so each border it
 * crossed is crossed the same way now - up to the first border moved out as
 * the border moved (`borderShift`), past it stretched as the pieces grew. In
 * the scenes' 0.4 m units, out in this build's.
 */
export function acrossBorders(chart: number, ux: number, uy: number): (x: number) => number {
  const border = borderAlong(chart, ux, uy);
  const old = border / SIZE;
  return (x) => {
    const u = x * U;
    return u <= old ? u + (border - old) : border + (u - old) * SIZE;
  };
}
