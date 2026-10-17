import { describe, expect, it } from 'vitest';

import { PLATE_SIZE, plateOf, plateRegion } from '@world/bounds';
import { cellDiagonal } from '@world/groundPatch';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { GROUND_MARGIN, GroundPastArea, GroundShare, groundOver, sharedGroundReaders } from '@render/sharedGround';
import { m } from '@world/units';
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
      const r = plateRegion(p);
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
    expect(onPlate).toBeGreaterThan(100);
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

  it('is only handed out where memory can be shared, and holds only the plates made', () => {
    const share = new GroundShare(N, CELL, HALF, BASE);
    // No slot per plate of a map: the world has none.
    expect(share.current?.plates.size).toBe(0);
    expect(share.current).toBe(share.current);
    const far = plateOf(PLATE_SIZE * 300, -PLATE_SIZE * 700);
    share.open(far);
    expect(share.current?.plates.get(far)).toBeInstanceOf(SharedArrayBuffer);
    expect(share.current?.plates.size).toBe(1);
  });

  it('reads a plate made far from the origin off its own corners', () => {
    const share = new GroundShare(N, CELL, HALF, BASE);
    share.setRelief(RELIEF_NATURAL);
    const key = plateOf(PLATE_SIZE * 1200, PLATE_SIZE * -900);
    const r = plateRegion(key);
    const plate = share.open(key)!;
    fill(plate.rendered, plate.flip, 3);
    fill(plate.natural, plate.naturalFlip, 1);
    const reads = sharedGroundReaders(share.current!);
    for (const [lx, ly] of [[0, 0], [-300.5, 200.25], [HALF - 1, -HALF + 1]] as const) {
      expect(reads.groundAt(r.cx + lx, r.cy + ly)).toBe(sampleCorners(grid, plate.rendered, plate.flip, lx, ly));
      expect(reads.naturalAt(r.cx + lx, r.cy + ly)).toBe(sampleCorners(grid, plate.natural, plate.naturalFlip, lx, ly));
    }
  });
});

describe('the ground handed to a job', () => {
  it('holds the plates under its box only, reads them as the whole share does, and refuses a read past it', () => {
    const share = new GroundShare(N, CELL, HALF, BASE);
    share.setRelief(RELIEF_NATURAL);
    // Five by five plates made round the origin (the map's ~1.6 MB each, here small).
    for (let pj = -2; pj <= 2; pj++) for (let pi = -2; pi <= 2; pi++) {
      const plate = share.open(plateOf(pi * PLATE_SIZE, pj * PLATE_SIZE))!;
      fill(plate.rendered, plate.flip, pi + pj);
      fill(plate.natural, plate.naturalFlip, pi - pj);
    }
    const whole = share.current!;
    expect(whole.plates.size).toBe(25);
    // A building cell's box inside one plate: that plate alone (DO NOT post the 25 with every job).
    const box = [m(100), m(100), m(356), m(356)] as const;
    const job = groundOver(whole, box);
    expect(job.plates.size).toBe(1);
    // Across a plate's edge (its margin too): the plates it touches.
    expect(groundOver(whole, [HALF - m(50), -m(10), HALF + m(50), m(10)]).plates.size).toBe(2);
    const all = sharedGroundReaders(whole), mine = sharedGroundReaders(structuredClone(job));
    for (let k = 0; k < 2000; k++) {
      const x = box[0] - GROUND_MARGIN + ((k * 7.31) % (box[2] - box[0] + 2 * GROUND_MARGIN)), y = box[1] - GROUND_MARGIN + ((k * 3.77) % (box[3] - box[1] + 2 * GROUND_MARGIN));
      expect(mine.groundAt(x, y)).toBe(all.groundAt(x, y));
      expect(mine.naturalAt(x, y)).toBe(all.naturalAt(x, y));
    }
    // Past the box and its margin a plate was never handed: its read would be the relief's, wrong, so it throws.
    expect(() => mine.groundAt(box[2] + GROUND_MARGIN + 1, box[1])).toThrow(GroundPastArea);
    // Told instead, where the job asks again over a wider box (`cellWork.ts`).
    const missed: number[] = [];
    sharedGroundReaders(job, (x, y) => missed.push(x, y)).naturalAt(-m(3000), m(10));
    expect(missed).toEqual([-m(3000), m(10)]);
  });
});
