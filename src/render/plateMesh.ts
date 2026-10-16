import { cellDiagonal } from '@world/groundPatch';
import { LandLevels } from './terrainLevels';

/** A TERRAIN PLATE'S GROUND FROM ITS CORNERS, off the page (`flatGround.worker.ts`) */
export interface PlateMesh {
  /** The ground at each corner, the terrain's base level added (`TERRAIN_BASE`). */
  readonly heights: Float64Array;
  /** Each cell's diagonal: 1 when it runs a-c (`terrain.ts` chooseDiagonals). */
  readonly flip: Uint8Array;
  /** The land's texels as the patches read them (`terrainLod.ts`): per corner its normal's x and z, its cell's diagonal and its height. */
  readonly texels: Float32Array;
  /** Its levels' nodes: bounds and errors (`LandLevels.data`). */
  readonly levels: Float32Array;
  /** The woods' density but the ecosystem's share, per cell (`woodsBase.ts`), when it was worked out with the ground. */
  woods?: Float32Array;
}

/** Each corner's normal in a box of corners (inclusive), area-weighted over the faces round it as three's `computeVertexNormals` forms them, into the land's texels (x, z). */
export function landNormalsInto(
  heights: ArrayLike<number>,
  flip: ArrayLike<number>,
  side: number,
  half: number,
  cell: number,
  texels: Float32Array,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  const seg = side - 1;
  const bx0 = Math.max(0, x0), bx1 = Math.min(seg, x1), by0 = Math.max(0, y0), by1 = Math.min(seg, y1);
  if (bx1 < bx0 || by1 < by0) return;
  const w = bx1 - bx0 + 1;
  const sums = new Float64Array(w * (by1 - by0 + 1) * 3);
  // The corners as the plate's mesh held them (float32): x across, z down the rows (three's axes).
  const px = (v: number): number => Math.fround((v % side) * cell - half);
  const pz = (v: number): number => Math.fround(Math.floor(v / side) * cell - half);
  const py = (v: number): number => Math.fround(heights[v] as number);
  let nx = 0, ny = 0, nz = 0;
  const add = (v: number): void => {
    const ix = v % side, iy = (v - ix) / side;
    if (ix < bx0 || ix > bx1 || iy < by0 || iy > by1) return;
    const o = ((ix - bx0) + (iy - by0) * w) * 3;
    sums[o] = sums[o]! + nx; sums[o + 1] = sums[o + 1]! + ny; sums[o + 2] = sums[o + 2]! + nz;
  };
  // One face's area-weighted normal, (c - b) x (a - b), added at its corners in the box.
  const face = (a: number, b: number, c: number): void => {
    const bx = px(b), by = py(b), bz = pz(b);
    const cbx = px(c) - bx, cby = py(c) - by, cbz = pz(c) - bz;
    const abx = px(a) - bx, aby = py(a) - by, abz = pz(a) - bz;
    nx = cby * abz - cbz * aby; ny = cbz * abx - cbx * abz; nz = cbx * aby - cby * abx;
    add(a); add(b); add(c);
  };
  for (let cy = Math.max(0, by0 - 1); cy <= Math.min(seg - 1, by1); cy++) {
    for (let cx = Math.max(0, bx0 - 1); cx <= Math.min(seg - 1, bx1); cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      if (flip[cx + cy * seg]) { face(a, b, c); face(a, c, d); } else { face(a, b, d); face(b, c, d); }
    }
  }
  for (let iy = by0; iy <= by1; iy++) {
    for (let ix = bx0; ix <= bx1; ix++) {
      const o = ((ix - bx0) + (iy - by0) * w) * 3, v = ix + iy * side;
      const sx = sums[o]!, sy = sums[o + 1]!, sz = sums[o + 2]!;
      const length = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      texels[v * 4] = sx / length;
      texels[v * 4 + 1] = sz / length;
    }
  }
}

/** Builds a plate's ground from its corners (`ground[j * side + i]`, without the base level). */
export function buildPlateMesh(ground: Float64Array, side: number, half: number, cell: number, base: number): PlateMesh {
  const seg = side - 1;
  const count = side * side;
  const heights = new Float64Array(count);
  const texels = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const h = base + ground[v]!;
    heights[v] = h;
    texels[v * 4 + 3] = h;
  }
  const flip = new Uint8Array(seg * seg);
  for (let cy = 0; cy < seg; cy++) {
    for (let cx = 0; cx < seg; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      // A margin, so near-flat cells keep the plane's diagonal.
      const k = cx + cy * seg;
      flip[k] = cellDiagonal(heights[a]!, heights[b]!, heights[c]!, heights[d]!);
      texels[(cx + cy * side) * 4 + 2] = flip[k]!;
    }
  }
  landNormalsInto(heights, flip, side, half, cell, texels, 0, seg, 0, seg);
  const levels = new LandLevels(seg);
  levels.markAll();
  levels.measure(heights, flip);
  return { heights, flip, texels, levels: levels.data };
}
