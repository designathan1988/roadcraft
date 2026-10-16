import { describe, expect, it } from 'vitest';

import { MAP_REGIONS, PLATE_SIZE, plateOf } from '@world/bounds';
import { cellDiagonal } from '@world/groundPatch';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { GroundShare, sharedGroundReaders } from '@render/sharedGround';
import { sampleCorners } from '@render/terrainShaping';

/** THE GROUND A WORKER READS OFF SHARED MEMORY IS THE PAGE'S (`sharedGround.ts`; the page: `flatAtlas.ts` `ask`, `terrain.ts` `sampleGrid`) */
const N = 33;
const CELL = PLATE_SIZE / (N - 1);
const HALF = PLATE_SIZE / 2;
const BASE = -0.048;
const grid = { n: N, cell: CELL, half: HALF };

/** Corners as a plate writes them (`terrain.ts`), each cell's diagonal by the same rule. */
function fill(corners: Float64Array, flips: Uint8Array, lift: number): void {
  for (let i = 0; i < N * N; i++) corners[i] = BASE + Math.sin(i * 0.37) * 3 + lift;
  for (let cy = 0; cy < N - 1; cy++) {
    for (let cx = 0; cx < N - 1; cx++) {
      const a = corners[cx + N * cy]!, b = corners[cx + N * (cy + 1)]!, c = corners[cx + 1 + N * (cy + 1)]!, d = corners[cx + 1 + N * cy]!;
      flips[cx + cy * (N - 1)] = cellDiagonal(a, b, c, d);
    }
  }
}

describe('the ground in shared memory', () => {
  it('reads a made plate as its corners are drawn and the others off the relief, as the page does', () => {
    const share = new GroundShare(N, CELL, HALF, BASE);
    share.setRelief(RELIEF_NATURAL);
    const centre = plateOf(0, 0);
    const plate = share.open(centre)!;
    expect(plate).not.toBeNull();
    fill(plate.rendered, plate.flip, 0);
    fill(plate.natural, plate.naturalFlip, -0.5);
    const reads = sharedGroundReaders(share.current!);
    /** The page's reads: the plate's surface where it is made, the base and the relief elsewhere. */
    const page = (natural: boolean, x: number, y: number): number => {
      const p = plateOf(x, y);
      const r = MAP_REGIONS[p]!;
      const lx = x - r.cx, ly = y - r.cy;
      if (p !== centre) return BASE + reliefHeight(RELIEF_NATURAL, r.cx + lx, r.cy + ly);
      return natural ? sampleCorners(grid, plate.natural, plate.naturalFlip, lx, ly) : sampleCorners(grid, plate.rendered, plate.flip, lx, ly);
    };
    let onPlate = 0;
    for (let k = 0; k < 4000; k++) {
      const x = Math.sin(k * 12.9898) * 3000, y = Math.cos(k * 78.233) * 3000;
      if (plateOf(x, y) === centre) onPlate++;
      expect(Object.is(reads.groundAt(x, y), page(false, x, y)), `${x}, ${y}`).toBe(true);
      expect(Object.is(reads.naturalAt(x, y), page(true, x, y)), `${x}, ${y}`).toBe(true);
    }
    expect(onPlate).toBeGreaterThan(500);
    // Its edges and corners, read on the plate itself.
    for (const [x, y] of [[-HALF, -HALF], [HALF, HALF], [-HALF, HALF], [0, HALF], [HALF, 0]] as const) {
      expect(reads.groundAt(x, y)).toBe(page(false, x, y));
    }
    // A corner written after the job was handed over: the worker reads it at once (one memory, no message).
    const middle = (N - 1) / 2;
    plate.rendered[middle + middle * N] = plate.rendered[middle + middle * N]! + 2;
    expect(reads.groundAt(0, 0)).toBe(plate.rendered[middle + middle * N]);
    // The plate let go: the next job reads the relief there, as the page does.
    share.close(centre);
    expect(sharedGroundReaders(share.current!).groundAt(10, 20)).toBe(BASE + reliefHeight(RELIEF_NATURAL, 10, 20));
  });

  it('is only handed out where memory can be shared', () => {
    const share = new GroundShare(N, CELL, HALF, BASE);
    expect(share.current?.plates).toHaveLength(MAP_REGIONS.length);
    expect(share.current).toBe(share.current);
    share.open(0);
    expect(share.current?.plates[0]).toBeInstanceOf(SharedArrayBuffer);
  });
});
