import { describe, expect, it } from 'vitest';
import { cellDiagonal } from '@world/groundPatch';
import { RELIEF_NATURAL, TerrainIndex, reliefHeight, sampleTerrainHeight, type TerrainStamp } from '@world/terrain';
import { m } from '@world/units';
import { serve } from '@render/landStroke.worker';
import type { LandStrokeJob } from '@render/landStroke';
import { LandLevels } from '@render/terrainLevels';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '@render/terrainGrid';
import { sampleCorners } from '@render/terrainShaping';
import { onPlate, woodsBase, woodsBaseInto, woodsOutsideReads, woodsSpan } from '@render/woodsBase';
import { NO_WATER, type WoodsBlock, shoreLevelsInto, writeWoodsBlock } from '@render/landStroke';
import { unifiedWaterGeometry } from '@render/terrain';
import type { BufferGeometry } from 'three';
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

describe("a dab's woods", () => {
  it('are worked out in the worker as the page works them out, the land off the plate read on the page', () => {
    const cx = m(-2_048), cy = m(4_096);
    const land = plate(cx, cy);
    const grid = { n: GRID, cell: TERRAIN_CELL, half: TERRAIN_HALF };
    // The page's natural land (`terrain.ts` naturalRenderedHeightAt): the corners on the plate, the stamps and the relief off it.
    const naturalAt = (x: number, y: number): number => (onPlate(TERRAIN_HALF, x, y) ? sampleCorners(grid, land.heights, land.flip, x, y) : land.naturalAt(x, y));
    const page = woodsBase(naturalAt, TERRAIN_HALF, cx, cy);
    const worker = page.slice();
    const cells = woodsSpan(TERRAIN_HALF, null).cells;
    const stamps: TerrainStamp[] = [
      { id: 1, x: -TERRAIN_HALF + m(8), y: TERRAIN_HALF - m(12), radius: m(50), strength: m(8), mode: 'raise', rough: true },
      { id: 2, x: m(40), y: m(-200), radius: m(30), strength: m(5), mode: 'lower' },
      { id: 3, x: TERRAIN_HALF - m(4), y: m(0), radius: m(70), strength: m(4), mode: 'flatten', level: m(-3) },
    ];
    let offPlate = 0;
    for (const stamp of stamps) {
      const box = land.dab(stamp);
      // `terrain.ts` rectOf: the box's corners a corner round, in the plate's own (x, y).
      const rect = [(box[0] - 1) * TERRAIN_CELL - TERRAIN_HALF, TERRAIN_HALF - (box[3] + 1) * TERRAIN_CELL,
        (box[1] + 1) * TERRAIN_CELL - TERRAIN_HALF, TERRAIN_HALF - (box[2] - 1) * TERRAIN_CELL] as const;
      const before = page.slice();
      woodsBaseInto(page, naturalAt, TERRAIN_HALF, cx, cy, rect);
      expect(page.some((v, k) => v !== before[k])).toBe(true);
      const points = woodsOutsideReads(TERRAIN_HALF, rect);
      const outside = new Float64Array(points.length / 2);
      for (let k = 0; k < outside.length; k++) outside[k] = land.naturalAt(points[k * 2]!, points[k * 2 + 1]!);
      offPlate += outside.length;
      const block = inWorker({ kind: 'woods', n: GRID, cell: TERRAIN_CELL, half: TERRAIN_HALF, cx, cy,
        natural: land.heights.slice(), flip: land.flip.slice(), rect, outside }) as WoodsBlock;
      writeWoodsBlock(worker, cells, block);
      same(worker, page);
    }
    // The edges' dabs read the land beyond the plate.
    expect(offPlate).toBeGreaterThan(0);
  });
});

/** The shore as the page worked it out before it went to the worker: read through the water mesh's attribute (`terrain.ts` shoreLevels, 2026-10-18). */
function shoreLevelsBefore(water: BufferGeometry, levels: Float32Array, ground: ArrayLike<number>): void {
  levels.fill(NO_WATER);
  const position = water.getAttribute('position');
  if (position) {
    for (let i = 0; i < position.count; i++) {
      const gx = (position.getX(i) + TERRAIN_HALF) / TERRAIN_CELL;
      const gy = (position.getZ(i) + TERRAIN_HALF) / TERRAIN_CELL;
      const ix = Math.round(gx);
      const iy = Math.round(gy);
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) continue;
      const k = iy * GRID + ix;
      if ((ground[k] as number) >= position.getY(i)) continue;
      levels[k] = Math.max(levels[k] as number, position.getY(i));
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const from = levels.slice();
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const k = iy * GRID + ix;
        if ((from[k] as number) > NO_WATER / 2) continue;
        let best = NO_WATER;
        if (ix > 0) best = Math.max(best, from[k - 1] as number);
        if (ix + 1 < GRID) best = Math.max(best, from[k + 1] as number);
        if (iy > 0) best = Math.max(best, from[k - GRID] as number);
        if (iy + 1 < GRID) best = Math.max(best, from[k + GRID] as number);
        if (best > NO_WATER / 2 && (ground[k] as number) < best) continue;
        levels[k] = best;
      }
    }
  }
}

describe('the shore of a water made again', () => {
  it('is worked out in the worker as the page worked it out', () => {
    const land = plate(m(1_000), m(2_000));
    // A river cut and its water, as `rebuildWater` lays it: a disc a few metres over the bed it carved.
    const river: TerrainStamp = { id: 1, x: m(60), y: m(-40), radius: m(45), strength: m(5), mode: 'river', rough: true };
    land.dab(river);
    const grid = { n: GRID, cell: TERRAIN_CELL, half: TERRAIN_HALF };
    const heightAt = (x: number, y: number): number => sampleCorners(grid, land.heights, land.flip, x, y);
    const bed = heightAt(river.x, river.y);
    const water = unifiedWaterGeometry([{ x: river.x, y: river.y, radius: river.radius * 0.92, level: bed + m(2) }], heightAt);
    const position = water.getAttribute('position');
    expect(position.count).toBeGreaterThan(0);
    const before = new Float32Array(GRID * GRID);
    shoreLevelsBefore(water, before, land.heights);
    expect(before.some((v) => v > NO_WATER / 2)).toBe(true);
    // The page now: the attribute's own array.
    const page = new Float32Array(GRID * GRID);
    shoreLevelsInto(page, position.array, position.count, land.heights);
    same(page, before);
    const answer = inWorker({ kind: 'shore', position: (position.array as Float32Array).slice(), count: position.count, ground: land.heights.slice() }) as Float32Array;
    same(answer, before);
  });
});
