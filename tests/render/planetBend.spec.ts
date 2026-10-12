import { describe, expect, it } from 'vitest';
import { type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_COUNT, TILE_HALF, tileToSphereInto } from '@core/planetTiles';
import { atlasToTileInto, tileCentre, type TileLocal } from '@world/planet/atlas';
import { rehome } from '@render/planet/bend';

/** The heading an azimuth gives on the sphere at an atlas point (the camera's back, over the ground), as the drawing turns it. */
function headingOnSphere(x: number, y: number, azimuth: number): Vec3 {
  const local: TileLocal = { tile: 0, x: 0, y: 0 };
  atlasToTileInto(x, y, local);
  const s = tileToSphereInto(local.tile, local.x, local.y, { x: 0, y: 0, z: 0 });
  const f = TILES[local.tile]!;
  const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a.x * b.x + a.y * b.y + a.z * b.z;
  const e = { x: f.east.x - dot(f.east, s) * s.x, y: f.east.y - dot(f.east, s) * s.y, z: f.east.z - dot(f.east, s) * s.z };
  const l = Math.hypot(e.x, e.y, e.z);
  e.x /= l; e.y /= l; e.z /= l;
  const n = { x: s.y * e.z - s.z * e.y, y: s.z * e.x - s.x * e.z, z: s.x * e.y - s.y * e.x };
  // World (cos az, sin az) over x (east) and z (= -north).
  const east = Math.cos(azimuth), north = -Math.sin(azimuth);
  return { x: east * e.x + north * n.x, y: east * e.y + north * n.y, z: east * e.z + north * n.z };
}

describe('the view carried over a piece border', () => {
  it('keeps its place and its heading on the sphere', () => {
    let worst = 0, moves = 0;
    for (let tile = 0; tile < TILE_COUNT; tile += 5) {
      const c = tileCentre(tile);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.8, 0.8], [-1, 0.4]] as const) {
        for (const az of [0, 1, 2.5, 4]) {
          const x = c.x + dx * (TILE_HALF + 40), y = c.y + dy * (TILE_HALF + 40);
          const moved = rehome(x, y);
          if (!moved) continue;
          moves++;
          const before = headingOnSphere(x, y, az);
          const after = headingOnSphere(moved.x, moved.y, az + moved.turn);
          const cos = before.x * after.x + before.y * after.y + before.z * after.z;
          worst = Math.max(worst, Math.acos(Math.min(1, cos)) * (180 / Math.PI));
        }
      }
    }
    expect(moves).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.5);
  });
});
