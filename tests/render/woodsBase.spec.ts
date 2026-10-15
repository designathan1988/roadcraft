import { describe, expect, it } from 'vitest';
import { WOODS_SLOPE_STEP, WOODS_SPACING, cornerLand, woodsBase } from '@render/woodsBase';
import { natureDensity } from '@render/natureNoise';

/** THE WOODS' DENSITY MADE OFF THE PAGE (`render/woodsBase.ts`) */
describe("the woods' base", () => {
  it('is the sweep\'s own density less the ecosystem\'s share', () => {
    const half = 160, cx = 3840, cy = -1920;
    const natural = (x: number, y: number): number => 12 * Math.sin(x / 37) + 5 * Math.cos(y / 23) + x * 0.08;
    const base = woodsBase(natural, half, cx, cy);
    const cells = Math.floor((2 * half) / WOODS_SPACING), d = WOODS_SLOPE_STEP;
    expect(base.length).toBe(cells * cells);
    for (let o = 0; o < base.length; o += 7) {
      const i = o % cells, j = Math.floor(o / cells);
      const x = -half + (i + 0.5) * WOODS_SPACING, y = -half + (j + 0.5) * WOODS_SPACING;
      const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
      const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
      const ecology = (o % 11) / 10;
      expect(base[o]! + ecology * 0.3).toBeCloseTo(natureDensity(x + cx, y + cy, 1, hillside, ecology), 6);
    }
  });

  it('reads the corners exactly, a plane exactly, and is continuous', () => {
    const side = 9, half = 32, cell = (2 * half) / (side - 1);
    const heights = new Float64Array(side * side), flip = new Uint8Array((side - 1) ** 2);
    const plane = (x: number, y: number): number => 0.3 * x - 0.7 * y + 4;
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) heights[j * side + i] = plane(-half + i * cell, half - j * cell);
    for (let k = 0; k < flip.length; k++) flip[k] = k % 3 === 0 ? 1 : 0;
    const land = cornerLand(heights, flip, side, half, cell, () => -99);
    for (let y = -half; y <= half; y += 1.7) for (let x = -half; x <= half; x += 1.3) expect(land(x, y)).toBeCloseTo(plane(x, y), 9);
    expect(land(half + 1, 0)).toBe(-99);
    // A bumpy field: corners exact, no jump across a cell's diagonal or edge.
    for (let k = 0; k < heights.length; k++) heights[k] = Math.sin(k * 1.7) * 3;
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) expect(land(-half + i * cell, half - j * cell)).toBeCloseTo(heights[j * side + i]!, 9);
    let worst = 0;
    for (let y = -half + 0.01; y < half; y += 0.37) for (let x = -half; x < half - 0.01; x += 0.01) worst = Math.max(worst, Math.abs(land(x + 0.01, y) - land(x, y)));
    expect(worst).toBeLessThan(0.05);
  });
});
