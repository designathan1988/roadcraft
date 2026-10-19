import { LandLevels } from './terrainLevels';

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

export type LandStrokeJob = LevelsJob;
export type LandStrokeAnswer<J extends LandStrokeJob> = J extends LevelsJob ? Float32Array : never;

/** The levels' nodes after `job.box` moved, as the page's `LandLevels` measures them (`markBox`, `measure`). */
export function measureLevels(job: LevelsJob): Float32Array {
  const levels = new LandLevels(job.seg);
  levels.take(job.levels);
  levels.markBox(job.box[0], job.box[1], job.box[2], job.box[3]);
  levels.measure(job.heights, job.flip);
  return levels.data;
}

/** A job's answer and the buffers it hands back. */
export function runLandStroke(job: LandStrokeJob): { readonly answer: unknown; readonly transfer: Transferable[] } {
  const data = measureLevels(job);
  return { answer: data, transfer: [data.buffer] };
}

/** Two boxes of corners as one (null: none yet). */
export const unionBox = (a: StrokeBox | null, b: StrokeBox): StrokeBox =>
  a === null ? b : [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
