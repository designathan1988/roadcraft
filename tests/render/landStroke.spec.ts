import { describe, expect, it } from 'vitest';
import { cellDiagonal } from '@world/groundPatch';
import { RELIEF_NATURAL, TerrainIndex, reliefHeight, sampleTerrainHeight, type TerrainStamp } from '@world/terrain';
import { m } from '@world/units';
import { serve } from '@render/landStroke.worker';
import type { LandStrokeJob } from '@render/landStroke';
import { LandLevels } from '@render/terrainLevels';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '@render/terrainGrid';
import type { JobScope } from '@/jobs/jobScope';

/** A DAB'S WORK ON A PLATE, ON THE PAGE AND IN ITS WORKER: the same arrays to the last float (`render/landStroke.ts`) */

const GRID = TERRAIN_SEGMENTS + 1;

/** The job run by the worker's own service, through a message's copy, and its answer. */
function inWorker(job: LandStrokeJob): unknown {
  let reply: unknown = null;
  const scope: JobScope = { onmessage: null, postMessage: (message) => { reply = structuredClone(message); } };
  serve(scope);
  scope.onmessage!(new MessageEvent('message', { data: structuredClone(job) }));
  const { answer, error } = reply as { answer?: unknown; error?: string };
  expect(error).toBeUndefined();
  return answer;
}

/** Two arrays bit for bit (NaN and -0 included). */
function same(a: ArrayLike<number>, b: ArrayLike<number>): void {
  expect(a.length).toBe(b.length);
  let differ = 0;
  for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) differ++;
  expect(differ).toBe(0);
}

/** A plate of the natural relief at (cx, cy), a dab's stamps over it: corners as `terrain.ts` rewrites them, diagonals as it chooses them. */
function plate(cx: number, cy: number) {
  const heights = new Float64Array(GRID * GRID);
  const flip = new Uint8Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS);
  const at = (ix: number, iy: number): [number, number] => [Math.fround(ix * TERRAIN_CELL - TERRAIN_HALF), -Math.fround(iy * TERRAIN_CELL - TERRAIN_HALF)];
  let index = new TerrainIndex([], 0, RELIEF_NATURAL, (x, y) => reliefHeight(RELIEF_NATURAL, x + cx, y + cy));
  const rewrite = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) heights[ix + iy * GRID] = sampleTerrainHeight(index, ...at(ix, iy));
    for (let y = Math.max(0, y0 - 1); y <= Math.min(TERRAIN_SEGMENTS - 1, y1); y++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(TERRAIN_SEGMENTS - 1, x1); x++) {
        flip[x + y * TERRAIN_SEGMENTS] = cellDiagonal(heights[x + GRID * y]!, heights[x + GRID * (y + 1)]!, heights[x + 1 + GRID * (y + 1)]!, heights[x + 1 + GRID * y]!);
      }
    }
  };
  rewrite(0, GRID - 1, 0, GRID - 1);
  /** A dab at (x, y), the plate's own: its corners rewritten, their box (corners, inclusive). */
  const dab = (stamp: TerrainStamp): [number, number, number, number] => {
    index = new TerrainIndex([...index.stamps, stamp], index.stamps.length + 1, RELIEF_NATURAL, index.ground, index);
    const reach = stamp.radius + TERRAIN_CELL;
    const box: [number, number, number, number] = [
      Math.max(0, Math.floor((stamp.x - reach + TERRAIN_HALF) / TERRAIN_CELL)), Math.min(GRID - 1, Math.ceil((stamp.x + reach + TERRAIN_HALF) / TERRAIN_CELL)),
      Math.max(0, Math.floor((TERRAIN_HALF - (stamp.y + reach)) / TERRAIN_CELL)), Math.min(GRID - 1, Math.ceil((TERRAIN_HALF - (stamp.y - reach)) / TERRAIN_CELL)),
    ];
    rewrite(...box);
    return box;
  };
  return { heights, flip, dab, naturalAt: (x: number, y: number) => sampleTerrainHeight(index, x, y) };
}

describe("a dab's levels", () => {
  it('are measured in the worker as the page measures them', () => {
    const land = plate(m(3_000), m(-1_000));
    const levels = new LandLevels(TERRAIN_SEGMENTS);
    levels.markAll();
    levels.measure(land.heights, land.flip);
    // Dabs in the plate, on its edge and across a node's seam, one after another as a stroke lays them.
    const stamps: TerrainStamp[] = [
      { id: 1, x: m(120), y: m(-80), radius: m(40), strength: m(6), mode: 'raise', rough: true },
      { id: 2, x: -TERRAIN_HALF + m(10), y: m(300), radius: m(60), strength: m(9), mode: 'lower' },
      { id: 3, x: m(128), y: m(128), radius: m(25), strength: m(3), mode: 'flatten', level: m(20) },
    ];
    for (const stamp of stamps) {
      const box = land.dab(stamp);
      const job: LandStrokeJob = { kind: 'levels', seg: TERRAIN_SEGMENTS, heights: land.heights.slice(), flip: land.flip.slice(), levels: levels.data.slice(), box };
      // The page as it did it: the box marked, the marked nodes measured.
      levels.markBox(box[0], box[1], box[2], box[3]);
      levels.measure(land.heights, land.flip);
      // The dab moved the levels: nothing compared here is the levels as they were.
      expect(levels.data.some((v, k) => v !== job.levels[k])).toBe(true);
      const answer = inWorker(job) as Float32Array;
      same(answer, levels.data);
      // Taken in, the page's levels are as measured, its worst errors with them.
      const taken = new LandLevels(TERRAIN_SEGMENTS);
      taken.take(answer);
      same(taken.worst, levels.worst);
    }
  });
});
