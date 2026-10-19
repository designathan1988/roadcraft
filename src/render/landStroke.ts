import { LandLevels } from './terrainLevels';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from './terrainGrid';
import { sampleCorners } from './terrainShaping';
import { onPlate, woodsBaseInto, woodsSpan } from './woodsBase';

/** WHAT A DAB OF THE BRUSH WORKS OUT AGAIN ON A PLATE, OFF THE PAGE (`landStroke.worker.ts`): no three.js, the page runs the same code when it has no workers */

/** A box of corners, inclusive: x0, x1 across, y0, y1 down (`terrainShaping.ts` TerrainRegion). */
export type StrokeBox = readonly [number, number, number, number];

/** The levels of a plate's drawn ground measured again over the corners a dab or a shaping pass moved (`terrainLevels.ts`). */
export interface LevelsJob {
  readonly kind: 'levels';
  /** Cells along a side of the plate. */
  readonly seg: number;
  /** The drawn corners and diagonals as they stand now (copies: the page goes on moving its own). */
  readonly heights: Float64Array;
  readonly flip: Uint8Array;
  /** The levels as the page holds them, every node measured (`LandLevels.data`). */
  readonly levels: Float32Array;
  readonly box: StrokeBox;
}

/** The woods' base worked out again over the cells a dab's natural land reaches (`woodsBase.ts` woodsBaseInto). */
export interface WoodsJob {
  readonly kind: 'woods';
  /** The plate's grid: corners along a side, a cell, half its side. */
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  /** Where the plate stands in the world: the woods' noise is the world's. */
  readonly cx: number;
  readonly cy: number;
  /** The natural corners and their diagonals as they stand now (copies). */
  readonly natural: Float64Array;
  readonly flip: Uint8Array;
  /** The plate's own (x, y) the dab moved: min x, min y, max x, max y. */
  readonly rect: readonly [number, number, number, number];
  /** The land at the points off the plate the cells read, in their order (`woodsOutsideReads`), read on the page. */
  readonly outside: Float64Array;
}
/** Some cells of the woods' base: the box of them (inclusive) and their values, row by row. */
export interface WoodsBlock { readonly i0: number; readonly i1: number; readonly j0: number; readonly j1: number; readonly cells: Float32Array }

/** The water's level at the corners near water, for the water's mesh made again (`terrain.ts` rebuildWater). */
export interface ShoreJob {
  readonly kind: 'shore';
  /** The water mesh's positions, x, height, z a vertex (three's axes, the plate's own), and how many. */
  readonly position: Float32Array;
  readonly count: number;
  /** The drawn corners the water was made on (a copy). */
  readonly ground: Float64Array;
}

export type LandStrokeJob = LevelsJob | WoodsJob | ShoreJob;
export type LandStrokeAnswer<J extends LandStrokeJob> = J extends LevelsJob ? Float32Array : J extends WoodsJob ? WoodsBlock
  : J extends ShoreJob ? Float32Array : never;

/** A shore texel with no water near it (`shoreLevelsInto`). */
export const NO_WATER = -100_000;
/** Corners per side of a terrain plate. */
const GRID = TERRAIN_SEGMENTS + 1;

/** The water's level at every terrain corner within a few cells of water, for the shore bands of the terrain shader (`position`: the water mesh's x, height, z a vertex) */
export function shoreLevelsInto(levels: Float32Array, position: ArrayLike<number>, count: number, ground: ArrayLike<number>): void {
  levels.fill(NO_WATER);
  for (let i = 0; i < count; i++) {
    const gx = (position[i * 3]! + TERRAIN_HALF) / TERRAIN_CELL;
    const gy = (position[i * 3 + 2]! + TERRAIN_HALF) / TERRAIN_CELL;
    const ix = Math.round(gx);
    const iy = Math.round(gy);
    if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) continue;
    const k = iy * GRID + ix;
    // Only a corner the water really stands over
    if ((ground[k] as number) >= position[i * 3 + 1]!) continue;
    levels[k] = Math.max(levels[k] as number, position[i * 3 + 1]!);
  }
  // Out three corners (48 units, about 19 m), each pass taking the highest water next to it.
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
        // Only onto a BANK, ground above the water
        if (best > NO_WATER / 2 && (ground[k] as number) < best) continue;
        levels[k] = best;
      }
    }
  }
}

/** The levels' nodes after `job.box` moved, as the page's `LandLevels` measures them (`markBox`, `measure`). */
export function measureLevels(job: LevelsJob): Float32Array {
  const levels = new LandLevels(job.seg);
  levels.take(job.levels);
  levels.markBox(job.box[0], job.box[1], job.box[2], job.box[3]);
  levels.measure(job.heights, job.flip);
  return levels.data;
}

/** A whole base the cells are worked out in, kept between jobs by their worker: only the block asked is read back. */
export interface LandStrokeScratch { woods: Float32Array | null }

/** The cells of the base `job.rect` reaches, as the page works them out (`woodsBaseInto` on the plate's natural land, `terrain.ts` sampleGrid). */
export function woodsBlock(job: WoodsJob, scratch: LandStrokeScratch = { woods: null }): WoodsBlock {
  const { n, cell, half, natural, flip, outside } = job;
  const grid = { n, cell, half };
  let next = 0;
  // On the plate its corners, as the page reads them; off it the land the page read there, in the order the cells read it.
  const land = (x: number, y: number): number => (onPlate(half, x, y) ? sampleCorners(grid, natural, flip, x, y) : outside[next++]!);
  const { cells, i0, i1, j0, j1 } = woodsSpan(half, job.rect);
  if (scratch.woods?.length !== cells * cells) scratch.woods = new Float32Array(cells * cells);
  const whole = scratch.woods;
  woodsBaseInto(whole, land, half, job.cx, job.cy, job.rect);
  if (next !== outside.length) throw new Error(`the woods read ${next} points off the plate, ${outside.length} were given`);
  const w = Math.max(0, i1 - i0 + 1), h = Math.max(0, j1 - j0 + 1);
  const block = new Float32Array(w * h);
  for (let j = 0; j < h; j++) block.set(whole.subarray((j0 + j) * cells + i0, (j0 + j) * cells + i0 + w), j * w);
  return { i0, i1, j0, j1, cells: block };
}

/** A block of the woods' base written into the plate's own (`cells` along a side). */
export function writeWoodsBlock(woods: Float32Array, cells: number, block: WoodsBlock): void {
  const w = block.i1 - block.i0 + 1;
  for (let j = block.j0; j <= block.j1; j++) woods.set(block.cells.subarray((j - block.j0) * w, (j - block.j0 + 1) * w), j * cells + block.i0);
}

/** A job's answer and the buffers it hands back. */
export function runLandStroke(job: LandStrokeJob, scratch: LandStrokeScratch = { woods: null }): { readonly answer: unknown; readonly transfer: Transferable[] } {
  if (job.kind === 'shore') {
    const levels = new Float32Array(GRID * GRID);
    shoreLevelsInto(levels, job.position, job.count, job.ground);
    return { answer: levels, transfer: [levels.buffer] };
  }
  if (job.kind === 'woods') {
    const block = woodsBlock(job, scratch);
    return { answer: block, transfer: [block.cells.buffer] };
  }
  const data = measureLevels(job);
  return { answer: data, transfer: [data.buffer] };
}

/** Two rects of the plate's own (x, y) as one (null: none yet). */
export const unionRect = (a: readonly [number, number, number, number] | null, b: readonly [number, number, number, number]): readonly [number, number, number, number] =>
  a === null ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Two boxes of corners as one (null: none yet). */
export const unionBox = (a: StrokeBox | null, b: StrokeBox): StrokeBox =>
  a === null ? b : [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
