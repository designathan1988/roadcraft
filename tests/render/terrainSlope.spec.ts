import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { landSlope, slopeRequest, type LightGrid } from '@render/terrainLightCompute';

/** THE LAND'S SLOPE (`terrainLightCompute.ts`): the one channel of its light the ground reads, worked out from the heights alone */

const grid: LightGrid = { n: 41, cell: 6.4 };

/** Rolling land with a cliff through it. */
function land(seed: number): Float64Array {
  const rng = new Rng(seed), n = grid.n, h = new Float64Array(n * n);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) h[iy * n + ix] = Math.sin(ix * 0.3) * 8 + Math.cos(iy * 0.21) * 6 + (ix > 25 ? 30 : 0) + rng.float();
  return h;
}

/** The slope of a corner as the land's light measured it: half the steepest cell round it, half the mean of that round it. */
function reference(h: Float64Array, ix: number, iy: number): number {
  const n = grid.n;
  const steep = (x: number, y: number): number => {
    let most = 0;
    for (let cy = y - 1; cy <= y; cy++) for (let cx = x - 1; cx <= x; cx++) {
      if (cx < 0 || cy < 0 || cx >= n - 1 || cy >= n - 1) continue;
      const k = cy * n + cx, a = h[k]!, b = h[k + 1]!, c = h[k + n]!, d = h[k + n + 1]!;
      most = Math.max(most, Math.hypot((b - a + d - c) / (2 * grid.cell), (c - a + d - b) / (2 * grid.cell)));
    }
    return (Math.atan(most) * 180) / Math.PI;
  };
  let sum = 0, count = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const jx = ix + dx, jy = iy + dy;
    if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
    sum += steep(jx, jy); count++;
  }
  return Math.round(Math.min(1, (0.5 * steep(ix, iy) + 0.5 * (sum / count)) / 90) * 255);
}

describe('the land\'s slope', () => {
  it('measures every corner of the plate as the land\'s light did', () => {
    const h = land(7);
    const { rect, slope } = landSlope(grid, slopeRequest(grid, h, 'all'));
    expect(rect).toEqual({ x0: 0, x1: grid.n - 1, y0: 0, y1: grid.n - 1 });
    for (let iy = 0; iy < grid.n; iy++) for (let ix = 0; ix < grid.n; ix++) expect(slope[iy * grid.n + ix], `corner ${ix},${iy}`).toBe(reference(h, ix, iy));
  });

  it('works out only the corners a moved box reaches, from the heights round them, the same as the whole plate', () => {
    const h = land(11);
    const whole = landSlope(grid, slopeRequest(grid, h, 'all')).slope;
    for (const moved of [{ x0: 10, x1: 12, y0: 4, y1: 9 }, { x0: 0, x1: 1, y0: 38, y1: 40 }, { x0: 39, x1: 40, y0: 0, y1: 0 }]) {
      const request = slopeRequest(grid, h, moved);
      // The heights it carries: the box round the corners, not the plate.
      expect(request.heights.length).toBe((request.box.x1 - request.box.x0 + 1) * (request.box.y1 - request.box.y0 + 1));
      expect(request.heights.length).toBeLessThan(h.length);
      const { rect, slope } = landSlope(grid, request);
      expect(rect.x0).toBeLessThanOrEqual(moved.x0); expect(rect.x1).toBeGreaterThanOrEqual(moved.x1);
      const width = rect.x1 - rect.x0 + 1;
      for (let iy = rect.y0; iy <= rect.y1; iy++) for (let ix = rect.x0; ix <= rect.x1; ix++) {
        expect(slope[(iy - rect.y0) * width + ix - rect.x0]).toBe(whole[iy * grid.n + ix]);
      }
    }
  });

  it('reaches every corner whose slope a moved height alters', () => {
    const h = land(3);
    const before = landSlope(grid, slopeRequest(grid, h, 'all')).slope;
    h[20 * grid.n + 20] = h[20 * grid.n + 20]! + 25;
    const after = landSlope(grid, slopeRequest(grid, h, 'all')).slope;
    const { rect } = slopeRequest(grid, h, { x0: 20, x1: 20, y0: 20, y1: 20 });
    for (let iy = 0; iy < grid.n; iy++) for (let ix = 0; ix < grid.n; ix++) {
      const inside = ix >= rect.x0 && ix <= rect.x1 && iy >= rect.y0 && iy <= rect.y1;
      if (!inside) expect(after[iy * grid.n + ix], `corner ${ix},${iy} changed outside the box`).toBe(before[iy * grid.n + ix]);
    }
  });
});
