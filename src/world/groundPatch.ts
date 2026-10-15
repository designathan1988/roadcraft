/**
 * THE DRAWN GROUND OF A PLACE, AS NUMBERS: the land's heights at the corners
 * of the terrain's cells over a rectangle, and the height anywhere inside it
 * read as the terrain mesh reads its own corners (`render/terrain.ts`
 * `sampleGrid`): each cell split along the diagonal with the smaller rise
 * (Garland & Heckbert's data-dependent triangulation), the point on its
 * triangle's plane.
 *
 * What the growth's worker reads the ground through (`editor/growthReplica.ts`):
 * the page samples the ground at a lot's corners of the grid
 * (`sampleGroundPatch`) and sends them with the lot; the worker answers any
 * point of the lot from them (`patchGround`) - the same triangles the ground
 * is drawn with, never a copy of the whole map's ground.
 *
 * Pure: no three, no DOM.
 */

/** The diagonal a cell is drawn with: 1 the a-c one, 0 the b-d one (a margin keeps near-flat cells on b-d). */
export function cellDiagonal(a: number, b: number, c: number, d: number): 0 | 1 {
  return Math.abs(a - c) + 0.5 < Math.abs(b - d) ? 1 : 0;
}

/**
 * The height at (u, v) of a cell with corners a (u 0, v 0), b (0, 1), c (1, 1),
 * d (1, 0), split along `diagonal` (`cellDiagonal`). DO NOT change it here
 * alone: the terrain mesh is drawn with it (`render/terrain.ts`).
 */
export function cellHeight(a: number, b: number, c: number, d: number, u: number, v: number, diagonal: number): number {
  if (diagonal) return u >= v ? a * (1 - u) + d * (u - v) + c * v : a * (1 - v) + b * (v - u) + c * u;
  return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
}

/** How close to a grid line a point counts as on it: the corner itself, not a hair into the next cell. */
const ON_LINE = 1e-9;

/**
 * The height at (x, y) from the corners of a grid of `cell` over the plane:
 * corner (i, j) stands at (i·cell, -j·cell) - rows numbered southwards, as the
 * terrain's are. A point within `ON_LINE` of a line of the grid is read on it,
 * so a corner reads its own height exactly.
 */
export function latticeHeight(x: number, y: number, cell: number, corner: (i: number, j: number) => number): number {
  let gx = x / cell, gy = -y / cell;
  const rx = Math.round(gx), ry = Math.round(gy);
  if (Math.abs(gx - rx) < ON_LINE) gx = rx;
  if (Math.abs(gy - ry) < ON_LINE) gy = ry;
  const i = Math.floor(gx), j = Math.floor(gy);
  const u = gx - i, v = gy - j;
  const a = corner(i, j), b = corner(i, j + 1), c = corner(i + 1, j + 1), d = corner(i + 1, j);
  return cellHeight(a, b, c, d, u, v, cellDiagonal(a, b, c, d));
}

/** The ground's corners over a rectangle: columns `i0`.., rows `j0`.. (southwards), `cols` × `rows` corners. */
export interface GroundPatch {
  readonly cell: number;
  readonly i0: number;
  readonly j0: number;
  readonly cols: number;
  readonly rows: number;
  /** Row by row, `cols` a row. */
  readonly heights: Float64Array;
}

/** The corners round a rectangle [minX, minY, maxX, maxY], each read off `groundAt` at the corner itself. */
export function sampleGroundPatch(rect: readonly [number, number, number, number], cell: number, groundAt: (x: number, y: number) => number): GroundPatch {
  const i0 = Math.floor(rect[0] / cell), i1 = Math.floor(rect[2] / cell) + 1;
  const j0 = Math.floor(-rect[3] / cell), j1 = Math.floor(-rect[1] / cell) + 1;
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
  const heights = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) heights[j * cols + i] = groundAt((i0 + i) * cell, -(j0 + j) * cell);
  return { cell, i0, j0, cols, rows, heights };
}

/** A point read off a patch outside it: the patch sent was too small for what was asked (`GrowthMiss`). */
export class PatchMiss extends Error {
  constructor(readonly x: number, readonly y: number) {
    super(`the ground was read at (${x}, ${y}), off the patch sent`);
  }
}

/** The ground of a patch at any point within it, as the terrain draws it; `PatchMiss` off it. */
export function patchGround(patch: GroundPatch): (x: number, y: number) => number {
  const { cell, i0, j0, cols, rows, heights } = patch;
  return (x, y) => latticeHeight(x, y, cell, (i, j) => {
    const ci = i - i0, cj = j - j0;
    if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) throw new PatchMiss(x, y);
    return heights[cj * cols + ci]!;
  });
}
