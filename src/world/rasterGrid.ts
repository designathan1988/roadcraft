import type { ChangeRect } from './changes';

/**
 * A raster over the plane and the states of its cells, shared by the paved
 * raster (`zoneGrid.ts` `markPaved`, `poleLines.ts` `markPlates`) and the lots'
 * labelling (`lots.ts`).
 */

/** A raster: `W` x `H` cells of side `step` from (`minX`, `minY`); cell (i, j)'s centre is `minX + (i + 0.5) * step`, `minY + (j + 0.5) * step`. */
export interface RasterGrid {
  readonly minX: number;
  readonly minY: number;
  readonly W: number;
  readonly H: number;
  readonly step: number;
}

/** A raster cell's state in the label array: land not asked about (no street near), and land of no piece yet. */
export const LAND = -1;
/** A raster cell's state: paved. */
export const PAVED = -2;
/** A raster cell's state: within a street's reach, to be asked whether paved (`markPaved` turns it to `PAVED` or `LAND`). */
export const NEAR = -3;

/** The rectangle holding every cell centre of a raster. */
export const gridRect = (g: RasterGrid): ChangeRect => [g.minX, g.minY, g.minX + g.W * g.step, g.minY + g.H * g.step];

/**
 * The first index in [lo, hi) where a predicate false then true along the
 * range (monotone) turns true; `hi` when it never does.
 */
export function firstTrue(lo: number, hi: number, pred: (i: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}
