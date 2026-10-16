import type { Aabb } from '@core/aabb';
import { cellHeight } from '@world/groundPatch';

/** WHICH CORNERS OF A PLATE'S GROUND A SHAPING PASS ASKS */

/** A box of grid corners, inclusive: x0..x1 across, y0..y1 down. */
export type TerrainRegion = readonly [number, number, number, number];

/** What `shapeToRoads` needs to know about the road network. */
export interface TerrainShaper {
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /** Boxes outside which `shapeAt` always answers weight 0. */
  shapeBounds(): readonly Aabb[];
}

/** A plate's grid of corners: `n` a side, corner `i` at `ix + iy * n`, and its world point. */
export interface CornerGrid {
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  x(i: number): number;
  y(i: number): number;
}

/** DO NOT walk `shapeBounds` against the regions: every box of the town */
export function shapeCorners(
  grid: CornerGrid,
  natural: ArrayLike<number>,
  shape: TerrainShaper,
  regions: readonly TerrainRegion[] | null,
  visited: Int32Array,
  pass: number,
  take: (i: number, height: number) => void,
): void {
  const n = grid.n;
  const visit = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = ix + iy * n;
        if (visited[i] === pass) continue;
        visited[i] = pass;
        const ground = natural[i] as number;
        const { height, weight } = shape.shapeAt(grid.x(i), grid.y(i), ground);
        if (weight <= 0.001) continue;
        const blended = ground + (height - ground) * weight;
        if (Math.abs(blended - ground) < 0.002) continue;
        take(i, blended);
      }
    }
  };
  for (const r of regions ?? shape.shapeBounds().map((box) => boxRegion(grid, box))) {
    visit(Math.max(0, r[0]), Math.min(n - 1, r[1]), Math.max(0, r[2]), Math.min(n - 1, r[3]));
  }
}

/** The corners a box of the plate's coordinates covers, a corner round (clamped where they are visited). */
export function boxRegion(grid: Pick<CornerGrid, 'cell' | 'half'>, box: Aabb): TerrainRegion {
  return [
    Math.floor((box.minX + grid.half) / grid.cell), Math.ceil((box.maxX + grid.half) / grid.cell),
    Math.floor((grid.half - box.maxY) / grid.cell), Math.ceil((grid.half - box.minY) / grid.cell),
  ];
}

type ShapeAt = TerrainShaper['shapeAt'];

/** The roads' and the buildings' platforms' shaping as one (`renderer.ts` `shapeGround`, and the ground's worker) */
export function shapeBoth(roads: { shapeAt: ShapeAt } | null, pads: { shapeAt: ShapeAt }): ShapeAt {
  return (x, y, ground) => {
    const road = roads ? roads.shapeAt(x, y, ground) : { height: ground, weight: 0 };
    const pad = pads.shapeAt(x, y, ground);
    if (pad.weight <= 0) return road;
    if (road.weight <= 0) return pad;
    return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
  };
}

/** The height a plate's ground is drawn at, at a point of the plate (its own coordinates, inside it) */
export function sampleCorners(grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>, corners: ArrayLike<number>, diagonals: ArrayLike<number>, x: number, y: number): number {
  const n = grid.n;
  const segments = n - 1;
  // `PlaneGeometry` lays its rows from +y downwards, so the row index grows as world y falls.
  const gx = (x + grid.half) / grid.cell;
  const gy = (grid.half - y) / grid.cell;
  const ix = Math.min(segments - 1, Math.floor(gx));
  const iy = Math.min(segments - 1, Math.floor(gy));
  const u = gx - ix;
  const v = gy - iy;
  const a = corners[ix + iy * n] as number;
  const b = corners[ix + (iy + 1) * n] as number;
  const c = corners[ix + 1 + (iy + 1) * n] as number;
  const d = corners[ix + 1 + iy * n] as number;
  // Each cell is split along the diagonal it is DRAWN with (`terrain.ts` rediagonal, the patches' level 0): one rule with the growth's worker (`world/groundPatch.ts` `cellHeight`).
  return cellHeight(a, b, c, d, u, v, diagonals[ix + iy * segments] as number);
}
