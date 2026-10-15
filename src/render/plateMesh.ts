import { cellDiagonal } from '@world/groundPatch';
import { steepnessInto } from './terrainSteep';

/**
 * A TERRAIN PLATE'S MESH FROM ITS CORNERS, off the page (`flatGround.worker.ts`):
 * what a plate's first build works out over its 90 601 corners
 * (`terrain.ts` update: rewrite, the diagonals, `computeVertexNormals`, the
 * steepness), the same numbers, so the page only copies them in. As Cesium
 * builds its terrain meshes - their vertices and normals - in a worker
 * (`createVerticesFromHeightmap`) and the main thread only uploads them; a
 * plate's first build was some 35 ms of a frame on the page (profiled 2026-10-11).
 *
 * Corners: `side` x `side`, rows from the plate's north edge down (as
 * `PlaneGeometry` lays them, rotated flat), x from -half, `cell` apart.
 */
export interface PlateMesh {
  /** The ground at each corner, the terrain's base level added (`TERRAIN_BASE`). */
  readonly heights: Float64Array;
  /** Each cell's diagonal: 1 when it runs a-c (`terrain.ts` chooseDiagonals). */
  readonly flip: Uint8Array;
  /** Each corner's normal, three's axes, area-weighted over its faces as three's `computeVertexNormals`. */
  readonly normals: Float32Array;
  /** Each corner's steepest face, degrees (`terrainSteep.ts`). */
  readonly steep: Float32Array;
  readonly low: number;
  readonly high: number;
  /** The woods' density but the ecosystem's share, per cell (`woodsBase.ts`), when it was worked out with the mesh. */
  woods?: Float32Array;
}

/** Builds a plate's mesh data from its ground (`ground[j * side + i]`, without the base level). */
export function buildPlateMesh(ground: Float64Array, side: number, half: number, cell: number, base: number): PlateMesh {
  const seg = side - 1;
  const count = side * side;
  const heights = new Float64Array(count);
  // The positions as the geometry holds them (float32), so the normals and the steepness read the same numbers.
  const positions = new Float32Array(count * 3);
  let low = Infinity, high = -Infinity;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      const h = base + ground[v]!;
      heights[v] = h;
      if (h < low) low = h;
      if (h > high) high = h;
      positions[v * 3] = -half + i * cell;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = -(half - j * cell);
    }
  }
  const flip = new Uint8Array(seg * seg);
  for (let cy = 0; cy < seg; cy++) {
    for (let cx = 0; cx < seg; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      // A margin, so near-flat cells keep the plane's diagonal.
      flip[cx + cy * seg] = cellDiagonal(heights[a]!, heights[b]!, heights[c]!, heights[d]!);
    }
  }
  // Area-weighted face normals summed at each corner: (c - b) x (a - b) per triangle, as three forms them.
  const sum = new Float64Array(count * 3);
  const addFace = (a: number, b: number, c: number): void => {
    const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!;
    const cbx = positions[c * 3]! - bx, cby = positions[c * 3 + 1]! - by, cbz = positions[c * 3 + 2]! - bz;
    const abx = positions[a * 3]! - bx, aby = positions[a * 3 + 1]! - by, abz = positions[a * 3 + 2]! - bz;
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    for (let k = 0; k < 3; k++) {
      const v = (k === 0 ? a : k === 1 ? b : c) * 3;
      sum[v] = sum[v]! + nx; sum[v + 1] = sum[v + 1]! + ny; sum[v + 2] = sum[v + 2]! + nz;
    }
  };
  for (let cy = 0; cy < seg; cy++) {
    for (let cx = 0; cx < seg; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      if (flip[cx + cy * seg]) { addFace(a, b, c); addFace(a, c, d); } else { addFace(a, b, d); addFace(b, c, d); }
    }
  }
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = sum[v * 3]!, y = sum[v * 3 + 1]!, z = sum[v * 3 + 2]!;
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    normals[v * 3] = x / length; normals[v * 3 + 1] = y / length; normals[v * 3 + 2] = z / length;
  }
  const steep = new Float32Array(count);
  steepnessInto(positions, flip, side, new Float32Array(seg * seg), steep);
  return { heights, flip, normals, steep, low, high };
}
