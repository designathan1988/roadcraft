import { describe, expect, it } from 'vitest';
import { FACE_HALF, PLANET_RADIUS, faceToSphereInto, type Vec3 } from '@core/cubeSphere';
import { TILES_PER_SIDE, tileOfDirection } from '@core/planetTiles';
import { GRID_CELL, onGrid, snapToGrid } from '@world/grid';
import { GRID_ORIGIN, atlasToSphereInto, faceGridHeading, sphereToChartInto } from '@world/planet/charts';
import { sphereToTileInto, tileToSphereInto } from '@core/planetTiles';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { setGridSnapStep, snapRoadEndpoint } from '@editor/snap';
import { U } from './_border';

/**
 * THE GRID ON THE PLANET (`world/grid.ts` snapToGrid, `world/planet/charts.ts`
 * snapToFaceGridInto; drawn by `render/terrain.ts` uGrid). Run with
 * `vitest.planet.config.ts`.
 *
 * Drawn and snapped on every piece's own map, the grid broke at each piece's
 * border: two charts put their lines a few metres apart and turned, and a
 * road snapped on one did not meet the grid of the next. Then the cube
 * faces' own: continuous, but bent at every cube edge and met three ways at
 * the corners (the player, 2026-10-10). It is now one map about one point of
 * the planet (`GRID_ORIGIN`): smooth everywhere but at the far side.
 */

const s = (): Vec3 => ({ x: 0, y: 0, z: 0 });
/** The arc between two directions (atan2 of the cross and the dot: exact near zero, unlike acos). */
const arc = (a: Vec3, b: Vec3): number => {
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z) * PLANET_RADIUS;
};

/** The grid point a sphere direction snaps to, read on `chart`'s map, back on the sphere. */
function snappedOn(chart: number, d: Vec3, offset = 0): Vec3 {
  const p = sphereToChartInto(chart, d, { x: 0, y: 0 });
  const q = snapToGrid(p, GRID_CELL, offset);
  return atlasToSphereInto(q.x, q.y, s());
}

describe('the grid on the planet', () => {
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  const cases = [
    // A border between two pieces of one face.
    { name: 'between two pieces of a face', face: 2, x: -FACE_HALF + 6 * step - 4 * U, y: 333 * U, across: 9 * U },
    // An edge of the cube: two faces.
    { name: 'over an edge of the cube', face: 0, x: FACE_HALF - 6 * U, y: -517 * U, across: 14 * U },
  ];
  for (const c of cases) {
    it(`is one grid ${c.name}`, () => {
      const d = faceToSphereInto(c.face, c.x, c.y, s());
      const here = tileOfDirection(d);
      const there = tileOfDirection(faceToSphereInto(c.face, c.x + c.across, c.y, s()));
      expect(there).not.toBe(here);
      for (const offset of [0, GRID_CELL / 2]) {
        const a = snappedOn(here, d, offset), b = snappedOn(there, d, offset);
        // The same ground, whichever map it was read on.
        expect(arc(a, b)).toBeLessThan(1e-6);
        // And no farther than half a cell's diagonal from where it was.
        expect(arc(a, d)).toBeLessThan(GRID_CELL * 0.75);
      }
    });
  }

  it('lays a road drawn with the grid shown along its line, near a corner of the cube too', () => {
    // Near a cube corner, dragged some 17 degrees off the grid's line (the player's road).
    // The cube corner nearest the start of the map (face 3, the grid's origin's).
    const d = faceToSphereInto(3, 2610 * U, -2560 * U, s());
    const chart = tileOfDirection(d);
    const start = snapToGrid(sphereToChartInto(chart, d, { x: 0, y: 0 }), GRID_CELL);
    const east = faceGridHeading(start.x, start.y, 0);
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    setGridSnapStep(GRID_CELL);
    const off = east + 0.3;
    const raw = { x: start.x + Math.cos(off) * 230 * U, y: start.y + Math.sin(off) * 230 * U };
    const end = snapRoadEndpoint(doc, net, { kind: 'free', at: start }, raw, 1, 0).at;
    const onGridMap = (p: { x: number; y: number }) => sphereToTileInto(GRID_ORIGIN, atlasToSphereInto(p.x, p.y, s()), { x: 0, y: 0 });
    const a = onGridMap(start), b = onGridMap(end);
    // On the grid line it started on, some nine cells on.
    expect(Math.abs(b.y - a.y)).toBeLessThan(1e-6);
    expect(Math.round(Math.abs(b.x - a.x) / GRID_CELL)).toBeGreaterThanOrEqual(8);
    expect(Math.round(Math.abs(b.x - a.x) / GRID_CELL)).toBeLessThanOrEqual(11);
  });

  it('runs its lines straight on over the edges and corners of the cube: no bend anywhere near the town', () => {
    // Every grid line within 1 200 m of the origin, followed in steps of
    // a cell: the turn from one step to the next stays a hair (a line of the
    // map about a point is a smooth curve; the faces' grid turned 30-90
    // degrees at an edge or a corner).
    let worst = 0;
    const p = s(), q = s(), r = s();
    for (let line = -3000 * U; line <= 3000 * U; line += 250 * U) {
      for (const axis of [0, 1]) {
        for (let t = -3000 * U; t < 3000 * U - 2 * GRID_CELL; t += GRID_CELL) {
          const at = (u: number, out: Vec3) => (axis === 0 ? tileToSphereInto(GRID_ORIGIN, u, line, out) : tileToSphereInto(GRID_ORIGIN, line, u, out));
          at(t, p); at(t + GRID_CELL, q); at(t + 2 * GRID_CELL, r);
          const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z, vx = r.x - q.x, vy = r.y - q.y, vz = r.z - q.z;
          const turn = Math.acos(Math.min(1, (ux * vx + uy * vy + uz * vz) / Math.hypot(ux, uy, uz) / Math.hypot(vx, vy, vz)));
          worst = Math.max(worst, turn);
        }
      }
    }
    expect(worst * 180 / Math.PI).toBeLessThan(1);
  });

  it('keeps its cells a cell across and its points on their chart', () => {
    const chart = GRID_ORIGIN;
    const p = sphereToChartInto(chart, tileToSphereInto(GRID_ORIGIN, 41 * U, -77 * U, s()), { x: 0, y: 0 });
    const q = snapToGrid(p, GRID_CELL);
    expect(onGrid(q, GRID_CELL)).toBe(true);
    expect(onGrid(p, GRID_CELL)).toBe(false);
    const east = snapToGrid({ x: q.x + GRID_CELL, y: q.y }, GRID_CELL);
    const north = snapToGrid({ x: q.x, y: q.y + GRID_CELL }, GRID_CELL);
    const a = atlasToSphereInto(q.x, q.y, s());
    expect(arc(a, atlasToSphereInto(east.x, east.y, s()))).toBeCloseTo(GRID_CELL, 1);
    expect(arc(a, atlasToSphereInto(north.x, north.y, s()))).toBeCloseTo(GRID_CELL, 1);
    // Written on the chart it was asked on (its cell of the atlas).
    expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(GRID_CELL);
  });
});
