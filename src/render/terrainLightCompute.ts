/** THE LAND'S SLOPE per corner, from its heights alone: the one channel of the land's own light the ground's shader reads (`terrain.ts` `terrainSlope`) */

/** The corner grid: `n` corners a side, `cell` world units apart, centred on the origin. */
export interface LightGrid {
  readonly n: number;
  readonly cell: number;
}

/** Corners, inclusive, columns x0..x1 and rows y0..y1 (rows run from +y downwards). */
export interface CornerRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** How far a corner's slope reads the heights round it, corners: the steepest cell round each corner (one), blended with its ring's (one more). */
const SLOPE_REACH = 2;

export const unionCorners = (a: CornerRect, b: CornerRect): CornerRect => ({
  x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
});

/** `r` grown by `by` corners, kept on the grid. */
const grownOn = (grid: LightGrid, r: CornerRect, by: number): CornerRect => ({
  x0: Math.max(0, r.x0 - by), x1: Math.min(grid.n - 1, r.x1 + by), y0: Math.max(0, r.y0 - by), y1: Math.min(grid.n - 1, r.y1 + by),
});

/** A request: the corners whose slope to work out, and the heights of the box round them they read (rows of the box's width). */
export interface LightRequest {
  readonly rect: CornerRect;
  readonly box: CornerRect;
  readonly heights: Float64Array;
}

/** Its answer: the slope of the corners in `rect`, a byte a corner (degrees over 90), rows of the rect's width. */
export interface LightResult {
  readonly rect: CornerRect;
  readonly slope: Uint8Array;
  /** Time the work took, ms. */
  readonly ms: number;
}

/** The request for the corners whose heights moved in `moved` ('all': every corner): the corners whose slope they alter, and the heights those read, copied. */
export function slopeRequest(grid: LightGrid, heights: Float64Array, moved: CornerRect | 'all'): LightRequest {
  const rect = moved === 'all' ? { x0: 0, x1: grid.n - 1, y0: 0, y1: grid.n - 1 } : grownOn(grid, moved, SLOPE_REACH);
  const box = grownOn(grid, rect, SLOPE_REACH);
  const width = box.x1 - box.x0 + 1;
  const copy = new Float64Array(width * (box.y1 - box.y0 + 1));
  for (let iy = box.y0; iy <= box.y1; iy++) copy.set(heights.subarray(iy * grid.n + box.x0, iy * grid.n + box.x1 + 1), (iy - box.y0) * width);
  return { rect, box, heights: copy };
}

/** Each corner's slope: half the steepest cell round it, half the mean of that over the corners round it, degrees (as the land's light always measured it). */
export function landSlope(grid: LightGrid, request: LightRequest): LightResult {
  const started = performance.now();
  const { rect, box, heights } = request;
  const n = grid.n, cell = grid.cell;
  const bw = box.x1 - box.x0 + 1;
  const h = (ix: number, iy: number): number => heights[(iy - box.y0) * bw + ix - box.x0]!;
  // The steepest cell round each corner of the rect and the ring round it, degrees.
  const s = grownOn(grid, rect, 1);
  const sw = s.x1 - s.x0 + 1;
  const steep = new Float32Array(sw * (s.y1 - s.y0 + 1));
  for (let iy = s.y0; iy <= s.y1; iy++) {
    for (let ix = s.x0; ix <= s.x1; ix++) {
      let most = 0;
      for (let cy = iy - 1; cy <= iy; cy++) {
        for (let cx = ix - 1; cx <= ix; cx++) {
          if (cx < 0 || cy < 0 || cx >= n - 1 || cy >= n - 1) continue;
          const a = h(cx, cy), b = h(cx + 1, cy), c = h(cx, cy + 1), d = h(cx + 1, cy + 1);
          const gx = (b - a + d - c) / (2 * cell), gy = (c - a + d - b) / (2 * cell);
          most = Math.max(most, Math.hypot(gx, gy));
        }
      }
      steep[(iy - s.y0) * sw + ix - s.x0] = (Math.atan(most) * 180) / Math.PI;
    }
  }
  const width = rect.x1 - rect.x0 + 1;
  const slope = new Uint8Array(width * (rect.y1 - rect.y0 + 1));
  for (let iy = rect.y0; iy <= rect.y1; iy++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx, jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
          sum += steep[(jy - s.y0) * sw + jx - s.x0]!; count++;
        }
      }
      const degrees = 0.5 * steep[(iy - s.y0) * sw + ix - s.x0]! + 0.5 * (sum / count);
      slope[(iy - rect.y0) * width + ix - rect.x0] = Math.round(Math.min(1, degrees / 90) * 255);
    }
  }
  return { rect, slope, ms: performance.now() - started };
}
