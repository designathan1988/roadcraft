import { m } from '@world/units';
import { natureDensity } from './natureNoise';

/** The woods' lattice: one candidate tree a cell this wide (`renderer.ts` natureSweep). */
export const WOODS_SPACING = m(5);
/** The step the land's slope is read over, either side of a cell's centre. */
export const WOODS_SLOPE_STEP = m(6);

/** THE WOODS' DENSITY OF A PLATE BUT ITS ECOSYSTEM, off the page (`flatGround.worker.ts`) */
export function woodsBase(natural: (x: number, y: number) => number, half: number, cx: number, cy: number): Float32Array {
  const cells = Math.floor((half * 2) / WOODS_SPACING);
  const out = new Float32Array(cells * cells);
  woodsBaseInto(out, natural, half, cx, cy, null);
  return out;
}

/** The base's cells whose slope reads the plate's own (x, y) in `rect` (null: every cell) worked out again into `out`: a stamp of the land redoes its own cells, never the plate's (`terrain.ts`). */
export function woodsBaseInto(out: Float32Array, natural: (x: number, y: number) => number, half: number, cx: number, cy: number,
  rect: readonly [number, number, number, number] | null): void {
  const { cells, i0, i1, j0, j1 } = woodsSpan(half, rect);
  const d = WOODS_SLOPE_STEP;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = -half + (i + 0.5) * WOODS_SPACING, y = -half + (j + 0.5) * WOODS_SPACING;
      const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
      const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
      out[j * cells + i] = natureDensity(x + cx, y + cy, m(1), hillside, 0);
    }
  }
}

/** The base's cells along a side, and the box of them (inclusive) whose slope reads the plate's own (x, y) in `rect` (null: every cell). */
export function woodsSpan(half: number, rect: readonly [number, number, number, number] | null): { cells: number; i0: number; i1: number; j0: number; j1: number } {
  const cells = Math.floor((half * 2) / WOODS_SPACING);
  const d = WOODS_SLOPE_STEP;
  // A cell reads the land `d` either side of its centre.
  return {
    cells,
    i0: rect ? Math.max(0, Math.floor((rect[0] - d + half) / WOODS_SPACING - 0.5)) : 0,
    i1: rect ? Math.min(cells - 1, Math.ceil((rect[2] + d + half) / WOODS_SPACING - 0.5)) : cells - 1,
    j0: rect ? Math.max(0, Math.floor((rect[1] - d + half) / WOODS_SPACING - 0.5)) : 0,
    j1: rect ? Math.min(cells - 1, Math.ceil((rect[3] + d + half) / WOODS_SPACING - 0.5)) : cells - 1,
  };
}

/** Whether a point of the plate's own (x, y) lies on it, as the terrain asks before reading its corners (`terrain.ts` sampleGrid). */
export const onPlate = (half: number, x: number, y: number): boolean => x >= -half && x <= half && y >= -half && y <= half;

/** The points off the plate `woodsBaseInto` reads over `rect`, x then y, in the order it reads them: their land read where the land beyond the plate is known (the page), handed to a worker that reads the plate's corners (`landStroke.ts`). */
export function woodsOutsideReads(half: number, rect: readonly [number, number, number, number] | null): Float64Array {
  const { i0, i1, j0, j1 } = woodsSpan(half, rect);
  const d = WOODS_SLOPE_STEP;
  const out: number[] = [];
  const read = (x: number, y: number): void => { if (!onPlate(half, x, y)) out.push(x, y); };
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = -half + (i + 0.5) * WOODS_SPACING, y = -half + (j + 0.5) * WOODS_SPACING;
      // As `woodsBaseInto` reads them, one after another.
      read(x + d, y); read(x - d, y); read(x, y + d); read(x, y - d);
    }
  }
  return Float64Array.from(out);
}

/** A plate's natural land read from its corners as the terrain reads them */
export function cornerLand(heights: Float64Array, flip: Uint8Array, side: number, half: number, cell: number, outside: (x: number, y: number) => number): (x: number, y: number) => number {
  const seg = side - 1;
  return (x, y) => {
    if (!(x >= -half && x <= half && y >= -half && y <= half)) return outside(x, y);
    const gx = (x + half) / cell, gy = (half - y) / cell;
    const ix = Math.min(seg - 1, Math.floor(gx)), iy = Math.min(seg - 1, Math.floor(gy));
    const u = gx - ix, v = gy - iy;
    const a = heights[ix + iy * side]!, b = heights[ix + (iy + 1) * side]!;
    const c = heights[ix + 1 + (iy + 1) * side]!, dd = heights[ix + 1 + iy * side]!;
    if (flip[ix + iy * seg]) return u >= v ? a * (1 - u) + dd * (u - v) + c * v : a * (1 - v) + b * (v - u) + c * u;
    return u + v <= 1 ? a * (1 - u - v) + dd * u + b * v : b * (1 - u) + c * (u + v - 1) + dd * (1 - v);
  };
}
