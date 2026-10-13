import { m } from '@world/units';
import { natureDensity } from './natureNoise';

/** The woods' lattice: one candidate tree a cell this wide (`renderer.ts` natureSweep). */
export const WOODS_SPACING = m(5);
/** The step the land's slope is read over, either side of a cell's centre. */
export const WOODS_SLOPE_STEP = m(6);

/**
 * THE WOODS' DENSITY OF A PLATE BUT ITS ECOSYSTEM, off the page
 * (`flatGround.worker.ts`): per cell of `WOODS_SPACING` the slow noise's
 * masses and the hillside (the natural land's slope), as the tree sweep
 * works them out (`renderer.ts` natureSweep) - the sweep then adds only the
 * ecosystem's share, the density being linear in it. Some 15 ms of every
 * plate's sweep on the page (profiled 2026-10-11).
 *
 * `natural(x, y)`: the plate's natural land at a point of its map (as
 * `naturalRenderedHeightAt`); `cx`, `cy`: the plate's centre in world
 * coordinates.
 */
export function woodsBase(natural: (x: number, y: number) => number, half: number, cx: number, cy: number): Float32Array {
  const cells = Math.floor((half * 2) / WOODS_SPACING);
  const out = new Float32Array(cells * cells);
  const d = WOODS_SLOPE_STEP;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = -half + (i + 0.5) * WOODS_SPACING, y = -half + (j + 0.5) * WOODS_SPACING;
      const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
      const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
      out[j * cells + i] = natureDensity(x + cx, y + cy, m(1), hillside, 0);
    }
  }
  return out;
}

/**
 * A plate's natural land read from its corners as the terrain reads them
 * (`terrain.ts` sampleGrid: bilinear over each cell's two triangles, split
 * along the diagonal it is drawn with), `outside` past its edge.
 */
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
