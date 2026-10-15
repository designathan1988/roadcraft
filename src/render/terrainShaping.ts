import type { Aabb } from '@core/aabb';

/**
 * WHICH CORNERS OF A PLATE'S GROUND A SHAPING PASS ASKS (`terrain.ts`
 * `shapeToRoads`), out of the mesh so the work of a pass can be counted
 * (`tests/render/terrainShaping.spec.ts`).
 */

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

/**
 * Asks `shape` at the corners a pass reshapes, each corner once (`visited`
 * stamped with `pass`), and hands every corner it moves to `take` with its
 * new height.
 *
 * With `regions` (the sites graded, a road edit's blocks, a brush dab): the
 * corners of the regions and nothing else - `shapeAt` answers weight 0
 * outside its `shapeBounds`, so a corner of a region outside every box is
 * left as it is by `shapeAt` itself. DO NOT walk `shapeBounds` against the
 * regions: every box of the town (every road's, every building's platform)
 * crossed with every region of the call was each corner visited once per box
 * and region over it - 1.4 s of one frame of a growing 2,560 m city, the sites
 * of thousands of buildings graded at once (2026-10-15).
 *
 * Without regions (the whole plate): the corners of the boxes, the only ones
 * `shapeAt` can move.
 */
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
  if (regions) {
    for (const r of regions) visit(Math.max(0, r[0]), Math.min(n - 1, r[1]), Math.max(0, r[2]), Math.min(n - 1, r[3]));
    return;
  }
  for (const box of shape.shapeBounds()) {
    visit(
      Math.max(0, Math.floor((box.minX + grid.half) / grid.cell)), Math.min(n - 1, Math.ceil((box.maxX + grid.half) / grid.cell)),
      Math.max(0, Math.floor((grid.half - box.maxY) / grid.cell)), Math.min(n - 1, Math.ceil((grid.half - box.minY) / grid.cell)),
    );
  }
}
