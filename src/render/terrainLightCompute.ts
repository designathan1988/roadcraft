/**
 * THE LAND'S OWN LIGHT, from its heights alone (`terrain.ts` draws it, the
 * worker in `terrainLight.worker.ts` works it out) - what makes a relief read
 * as one: the ground itself casts no shadow map (180 000 triangles drawn twice
 * a frame), so a chapada threw no shadow over the plain and a valley was as
 * bright as a ridge.
 *
 *  - SUN: from every corner a ray is marched towards the sun over the
 *    heightfield, keeping how near it passes over the ground for its distance
 *    (Inigo Quilez's soft shadows, min(k h / t)): fully lit, in the penumbra
 *    of a ridge, or behind it (the heightfield shadows of horizon and shadow
 *    height maps).
 *  - SKY: the horizon is found in eight directions round every corner and
 *    each direction sees 1 - sin^2 of it - three's GTAO integral for a surface
 *    seen from above - so valleys, hollows and the feet of walls see less sky.
 *
 * Worked out for the corners a change can reach and no others: a corner's
 * horizon depends only on the ground within its search (Stewart, "Fast
 * Horizon Computation at All Points of a Terrain With Visibility and
 * Shading Applications", TVCG 1997), so a road drawn relights the ground
 * round it, its sky's reach, and the band its relief can shade away from
 * the sun - as an engine refreshes a terrain's dirty region only (Unity,
 * `TerrainData.DirtyHeightmapRegion`). The whole map was lit again for every
 * quarter-block the ground was shaped in: fourteen times 120-220 ms for one
 * road (the player, 2026-10-08).
 *
 * Pure: no three, no DOM.
 */

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

export interface Sun {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * What the land's shape says per corner, for its colours (`lightLand`): its
 * share of the sky past the hills round it, its steepness - the steepest of
 * the four cells it shares, half blended with its neighbours', so a wall
 * stays a wall and its edge is a curve read bilinearly, not the mesh's
 * triangles - and its CONVEXITY, the Laplacian of the heights (World
 * Machine's convexity selector, Gaea's curvature map): ridges and tops
 * against hollows and valley floors.
 */
export interface LandShape {
  readonly sky: Float32Array;
  /** Degrees. */
  readonly slope: Float32Array;
  /** -1 a hollow, 0 even ground, 1 a ridge. */
  readonly convex: Float32Array;
  /** The steepest cell round each corner, degrees (what `slope` blends). */
  readonly steep: Float32Array;
}

/** How far round a corner its sky is looked for, in corners (`skyOf`). */
const SKY_REACH = [1, 2, 3, 5, 8, 12, 18, 27] as const;
/** The ring the convexity is measured against, in corners. */
const CONVEX_RING = 3;
/** The penumbra's width: k of Quilez's k h / t. */
const SOFT = 9;

export const wholeGrid = (grid: LightGrid): CornerRect => ({ x0: 0, x1: grid.n - 1, y0: 0, y1: grid.n - 1 });

const clampRect = (grid: LightGrid, r: CornerRect): CornerRect => ({
  x0: Math.max(0, Math.floor(r.x0)), x1: Math.min(grid.n - 1, Math.ceil(r.x1)),
  y0: Math.max(0, Math.floor(r.y0)), y1: Math.min(grid.n - 1, Math.ceil(r.y1)),
});

const grow = (r: CornerRect, by: number): CornerRect => ({ x0: r.x0 - by, x1: r.x1 + by, y0: r.y0 - by, y1: r.y1 + by });

export const unionCorners = (a: CornerRect, b: CornerRect): CornerRect => ({
  x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
});

export function emptyShape(grid: LightGrid): LandShape {
  const count = grid.n * grid.n;
  return { sky: new Float32Array(count), slope: new Float32Array(count), convex: new Float32Array(count), steep: new Float32Array(count) };
}

/** The corners whose shape (`shapeLand`) a change of the heights in `moved` alters. */
export const shapeReach = (grid: LightGrid, moved: CornerRect): CornerRect =>
  clampRect(grid, grow(moved, Math.max(SKY_REACH[SKY_REACH.length - 1]!, CONVEX_RING + 2)));

/** The land's shape (`LandShape`) worked out again for the corners in `rect`; the rest is kept. */
export function shapeLand(grid: LightGrid, heights: Float64Array, shape: LandShape, rect: CornerRect): void {
  const n = grid.n, cell = grid.cell;
  const { steep, slope, convex } = shape;
  // The steepness is blended with the ring round each corner: worked out one corner further.
  const s = clampRect(grid, grow(rect, 1));
  for (let iy = s.y0; iy <= s.y1; iy++) {
    for (let ix = s.x0; ix <= s.x1; ix++) {
      let most = 0;
      for (let cy = iy - 1; cy <= iy; cy++) {
        for (let cx = ix - 1; cx <= ix; cx++) {
          if (cx < 0 || cy < 0 || cx >= n - 1 || cy >= n - 1) continue;
          const k = cy * n + cx;
          const a = heights[k] as number, b = heights[k + 1] as number, c = heights[k + n] as number, d = heights[k + n + 1] as number;
          const gx = (b - a + d - c) / (2 * cell), gy = (c - a + d - b) / (2 * cell);
          most = Math.max(most, Math.hypot(gx, gy));
        }
      }
      steep[iy * n + ix] = (Math.atan(most) * 180) / Math.PI;
    }
  }
  const R = CONVEX_RING;
  for (let iy = rect.y0; iy <= rect.y1; iy++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx, jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
          sum += steep[jy * n + jx] as number; count++;
        }
      }
      const k = iy * n + ix;
      slope[k] = 0.5 * (steep[k] as number) + 0.5 * (sum / count);
      // Height over the mean of a ring three cells out.
      let ring = 0, m = 0;
      for (let a = 0; a < 8; a++) {
        const jx = Math.round(ix + Math.cos((a * Math.PI) / 4) * R), jy = Math.round(iy + Math.sin((a * Math.PI) / 4) * R);
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        ring += heights[jy * n + jx] as number; m++;
      }
      const lap = m > 0 ? (heights[k] as number) - ring / m : 0;
      convex[k] = Math.max(-1, Math.min(1, lap / (R * cell * 0.12)));
    }
  }
  skyOf(grid, heights, shape.sky, rect);
}

/** Each corner's share of the sky past the hills round it, 0..1, for the corners in `rect`. */
function skyOf(grid: LightGrid, heights: Float64Array, sky: Float32Array, rect: CornerRect): void {
  const n = grid.n;
  // Each sample as a grid offset and the distance it lies at, worked out once.
  const offX: number[] = [], offY: number[] = [], inv: number[] = [];
  for (let k = 0; k < 8; k++) {
    for (const r of SKY_REACH) {
      const ox = Math.round(Math.cos((k * Math.PI) / 4) * r), oy = Math.round(Math.sin((k * Math.PI) / 4) * r);
      offX.push(ox); offY.push(oy); inv.push(1 / (Math.hypot(ox, oy) * grid.cell));
    }
  }
  const per = SKY_REACH.length;
  for (let iy = rect.y0; iy <= rect.y1; iy++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const h0 = heights[iy * n + ix] as number;
      let seen = 0;
      for (let k = 0; k < 8; k++) {
        let tan = 0;
        for (let r = 0; r < per; r++) {
          const i = k * per + r;
          const jx = ix + (offX[i] as number), jy = iy + (offY[i] as number);
          if (jx < 0 || jy < 0 || jx >= n || jy >= n) break;
          const t = ((heights[jy * n + jx] as number) - h0) * (inv[i] as number);
          if (t > tan) tan = t;
        }
        // 1 - sin^2(horizon) = 1 / (1 + tan^2).
        seen += 1 / (1 + tan * tan);
      }
      sky[iy * n + ix] = seen / 8;
    }
  }
}

/** Towards the sun on the grid (`lightLand`). */
interface Aim { readonly dgx: number; readonly dgy: number; readonly rise: number }

function aimAt(grid: LightGrid, sun: Sun): Aim {
  // x grows with world x, the rows with -y (world y is three's -z, so the
  // rows grow with three's z).
  const hl = Math.hypot(sun.x, sun.z) || 1e-6;
  // Height gained per grid cell along the ray.
  return { dgx: sun.x / hl, dgy: sun.z / hl, rise: (Math.max(0.03, sun.y) / hl) * grid.cell };
}

function heightRange(heights: Float64Array): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i] as number;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

/**
 * The corners whose light a change of the heights in `moved` can alter: their
 * shape's reach (`shapeReach`), and every corner whose ray towards the sun
 * crosses the moved ground - those lying away from the sun from it, as far
 * as a ray can still pass under the highest ground ((max - min) / rise
 * cells; a ray above it is cut off, `lightLand`).
 */
export function lightReach(grid: LightGrid, heights: Float64Array, sun: Sun, moved: CornerRect): CornerRect {
  const aim = aimAt(grid, sun);
  const { min, max } = heightRange(heights);
  const t = Math.min(grid.n * 1.5, (max + 1 - min) / aim.rise + 1);
  // The moved ground carried back along the ray, plus the bilinear sample's corner.
  const back: CornerRect = { x0: moved.x0 - aim.dgx * t, x1: moved.x1 - aim.dgx * t, y0: moved.y0 - aim.dgy * t, y1: moved.y1 - aim.dgy * t };
  const swept = grow(unionCorners(moved, back), 2);
  return unionCorners(shapeReach(grid, moved), clampRect(grid, swept));
}

/**
 * The light of the corners in `rect`, RGBA a corner into `out` (`outWidth`
 * corners a row, the rect's first corner at 0): R the sun, G the sky, B the
 * convexity, A the slope.
 */
export function lightLand(
  grid: LightGrid,
  heights: Float64Array,
  sun: Sun,
  shape: LandShape,
  rect: CornerRect,
  out: Uint8Array,
  outWidth: number,
): void {
  const n = grid.n, cell = grid.cell;
  const { max: maxH } = heightRange(heights);
  const aim = aimAt(grid, sun);
  const at = (gx: number, gy: number): number => {
    const ix = Math.min(n - 2, Math.max(0, Math.floor(gx)));
    const iy = Math.min(n - 2, Math.max(0, Math.floor(gy)));
    const u = Math.min(1, Math.max(0, gx - ix)), v = Math.min(1, Math.max(0, gy - iy));
    const k = iy * n + ix;
    const a = heights[k] as number, b = heights[k + 1] as number, c = heights[k + n] as number, d = heights[k + n + 1] as number;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  for (let iy = rect.y0; iy <= rect.y1; iy++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const h0 = (heights[iy * n + ix] as number) + 0.4;
      let lit = 1;
      for (let t = 0.7; ; t += Math.max(0.5, t * 0.06)) {
        const gx = ix + aim.dgx * t, gy = iy + aim.dgy * t;
        if (gx < 0 || gy < 0 || gx > n - 1 || gy > n - 1) break;
        const ray = h0 + t * aim.rise;
        if (ray > maxH + 1) break;
        lit = Math.min(lit, (SOFT * (ray - at(gx, gy))) / (t * cell));
        if (lit <= 0) { lit = 0; break; }
      }
      const smooth = lit * lit * (3 - 2 * lit);
      const o = ((iy - rect.y0) * outWidth + (ix - rect.x0)) * 4;
      const k = iy * n + ix;
      out[o] = Math.round(smooth * 255);
      out[o + 1] = Math.round((shape.sky[k] as number) * 255);
      out[o + 2] = Math.round((0.5 + 0.5 * (shape.convex[k] as number)) * 255);
      out[o + 3] = Math.round(Math.min(1, (shape.slope[k] as number) / 90) * 255);
    }
  }
}

/** A request to the worker: the heights now, the sun, and what moved since the last. */
export interface LightRequest {
  readonly heights: Float64Array;
  readonly sun: Sun;
  /** The corners whose heights moved; 'all' the whole land; null none (the sun turned). */
  readonly moved: CornerRect | 'all' | null;
  /** The sun turned: every corner relit. */
  readonly relightAll: boolean;
}

/** Its answer: the light of the corners in `rect`, RGBA a corner, rows of the rect's width. */
export interface LightResult {
  readonly rect: CornerRect;
  readonly rgba: Uint8Array;
  /** Time the work took, ms. */
  readonly ms: number;
}

/**
 * The land's light kept between requests (the worker's own state, or the
 * page's when there is no worker): the shape of the whole land, worked out
 * again only where it moved.
 */
export function createLandLighter(grid: LightGrid): (request: LightRequest) => LightResult {
  let shape: LandShape | null = null;
  return (request) => {
    const started = performance.now();
    const { heights, sun, moved } = request;
    const whole = wholeGrid(grid);
    let rect: CornerRect;
    if (!shape || moved === 'all') {
      shape ??= emptyShape(grid);
      shapeLand(grid, heights, shape, whole);
      rect = whole;
    } else if (moved) {
      shapeLand(grid, heights, shape, shapeReach(grid, moved));
      rect = request.relightAll ? whole : lightReach(grid, heights, sun, moved);
    } else {
      rect = whole;
    }
    if (request.relightAll) rect = whole;
    const width = rect.x1 - rect.x0 + 1;
    const rgba = new Uint8Array(width * (rect.y1 - rect.y0 + 1) * 4);
    lightLand(grid, heights, sun, shape, rect, rgba, width);
    return { rect, rgba, ms: performance.now() - started };
  };
}
