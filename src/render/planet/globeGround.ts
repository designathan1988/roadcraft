import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { FACE_HALF, faceToSphereInto, type Vec3 } from '@core/cubeSphere';
import { TILE_COUNT, TILES_PER_SIDE } from '@core/planetTiles';
import type { ReliefVersion } from '@world/terrain';
import { tileCentre } from '@world/planet/atlas';
import { sphereToChartInto } from '@world/planet/charts';
import { FRONT_WIDTH_FAR } from '@world/planet/ice';
import { tileGround } from '@world/planet/relief';

/**
 * THE FAR GLOBE'S GROUND: the whole planet's land at low detail, in one
 * geometry drawn with the terrain's own material (`terrainAtlas.ts`), under
 * the few pieces kept in full near the view or with something on them.
 *
 * As a planet renderer pages its terrain (Proland's tile producer and cache:
 * "it is not possible to store in GPU memory the whole landscape data", the
 * coarse level shown where the fine one is missing; Cesium's quadtree the
 * same), the 864 pieces are no longer each a full flat-map surface - 864
 * meshes, materials and data textures, every per-frame loop over all of them -
 * but a coarse patch each, here, in one draw.
 *
 * Each piece's patch is `PATCH` x `PATCH` quads over its square of the cube
 * face (`core/planetTiles.ts`), its corners written on the piece's own chart
 * (`world/planet/atlas.ts`): a patch lies inside its piece's cell of the
 * atlas, as the bend (`bend.ts` planetTile) and the terrain shader read it,
 * and two patches give their shared edge the same points of the sphere.
 * The heights are the land's own (`planet/relief.ts`, as an untouched piece
 * has it), lowered `SKIRT` along every edge (a skirt, as chunked terrain
 * hides the step where a coarse patch meets a finer piece).
 */

/** Quads along each side of a piece's patch. */
export const PATCH = 8;
/** How far a patch's skirt hangs below its edge, world units. */
const SKIRT = 30;
const SIDE = PATCH + 1;
/** Corners a patch reads heights at: its own and a ring round them, for the normals. */
const RING = SIDE + 2;
const STEP = (2 * FACE_HALF) / TILES_PER_SIDE;

export interface GlobeGround {
  readonly geometry: BufferGeometry;
  /** The lowest and highest ground of each piece's patch (its skirt left out). */
  readonly low: Float32Array;
  readonly high: Float32Array;
  /**
   * The ground as drawn at a point of a piece's square of its face (`a`, `b`
   * from 0 to `PATCH` across it, the face's equiangular cells): the patch's
   * own triangles, so what stands on it stands on what is drawn.
   */
  heightAt(tile: number, a: number, b: number): number;
}

/**
 * The far globe's ground for a relief (`ReliefVersion`), every height the
 * land's own plus `base` (the terrain's `TERRAIN_BASE`).
 */
export function buildGlobeGround(relief: ReliefVersion, base: number): GlobeGround {
  const perTile = SIDE * SIDE + 4 * SIDE;
  const vertices = TILE_COUNT * perTile;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const steep = new Float32Array(vertices);
  const quads = PATCH * PATCH + 4 * PATCH * 2;
  const indices = new Uint32Array(TILE_COUNT * quads * 6);
  const low = new Float32Array(TILE_COUNT);
  const corners = new Float32Array(TILE_COUNT * SIDE * SIDE);
  const high = new Float32Array(TILE_COUNT);
  const heights = new Float64Array(RING * RING);
  const ax = new Float64Array(RING * RING), ay = new Float64Array(RING * RING);
  const s: Vec3 = { x: 0, y: 0, z: 0 };
  const at = { x: 0, y: 0 };
  let v = 0, w = 0;
  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const face = Math.floor(tile / (TILES_PER_SIDE * TILES_PER_SIDE));
    const k = tile % (TILES_PER_SIDE * TILES_PER_SIDE);
    const i = k % TILES_PER_SIDE, j = Math.floor(k / TILES_PER_SIDE);
    // The ice's front risen over three of the patch's quads, not the near
    // terrain's three cells: narrower, the coarse grid drew it in teeth.
    const ground = tileGround(tile, relief, FRONT_WIDTH_FAR);
    const c = tileCentre(tile);
    // The corners and a ring round them, on the face's grid, written on this piece's chart.
    for (let b = 0; b < RING; b++) {
      for (let a = 0; a < RING; a++) {
        const fx = -FACE_HALF + (i + (a - 1) / PATCH) * STEP;
        const fy = -FACE_HALF + (j + (b - 1) / PATCH) * STEP;
        faceToSphereInto(face, fx, fy, s);
        sphereToChartInto(tile, s, at);
        const n = b * RING + a;
        ax[n] = at.x;
        ay[n] = at.y;
        heights[n] = base + ground(at.x - c.x, at.y - c.y);
      }
    }
    let lo = Infinity, hi = -Infinity;
    const first = v;
    for (let b = 1; b <= SIDE; b++) {
      for (let a = 1; a <= SIDE; a++) {
        const n = b * RING + a;
        const h = heights[n]!;
        corners[tile * SIDE * SIDE + (b - 1) * SIDE + (a - 1)] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        // The normal from the neighbours (east-west and north-south), in the
        // piece's own frame: x east, y up, z south (three's, `bend.ts`).
        const dxe = ax[n + 1]! - ax[n - 1]!, dye = ay[n + 1]! - ay[n - 1]!;
        const dxn = ax[n + RING]! - ax[n - RING]!, dyn = ay[n + RING]! - ay[n - RING]!;
        const dhe = heights[n + 1]! - heights[n - 1]!, dhn = heights[n + RING]! - heights[n - RING]!;
        // Tangents (x, h, -y) along the two grid lines; the normal is their cross product.
        const tx = dxe, ty = dhe, tz = -dye;
        const ux = dxn, uy = dhn, uz = -dyn;
        let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const len = Math.hypot(nx, ny, nz) || 1;
        positions[v * 3] = ax[n]!;
        positions[v * 3 + 1] = h;
        positions[v * 3 + 2] = -ay[n]!;
        normals[v * 3] = nx / len;
        normals[v * 3 + 1] = ny / len;
        normals[v * 3 + 2] = nz / len;
        steep[v] = Math.acos(Math.min(1, ny / len)) * (180 / Math.PI);
        v++;
      }
    }
    low[tile] = lo;
    high[tile] = hi;
    const corner = (a: number, b: number): number => first + b * SIDE + a;
    for (let b = 0; b < PATCH; b++) {
      for (let a = 0; a < PATCH; a++) {
        const p00 = corner(a, b), p10 = corner(a + 1, b), p01 = corner(a, b + 1), p11 = corner(a + 1, b + 1);
        // Counter-clockwise seen from above (east x north = up).
        indices[w++] = p00; indices[w++] = p10; indices[w++] = p01;
        indices[w++] = p10; indices[w++] = p11; indices[w++] = p01;
      }
    }
    // The skirt: each edge's corners again, hung below, joined both ways round
    // (it is seen from either side).
    const edges: (readonly [number, number])[][] = [
      Array.from({ length: SIDE }, (_, a) => [a, 0] as const),
      Array.from({ length: SIDE }, (_, a) => [a, PATCH] as const),
      Array.from({ length: SIDE }, (_, b) => [0, b] as const),
      Array.from({ length: SIDE }, (_, b) => [PATCH, b] as const),
    ];
    for (const edge of edges) {
      const hung = v;
      for (const [a, b] of edge) {
        const top = corner(a, b);
        positions[v * 3] = positions[top * 3]!;
        positions[v * 3 + 1] = positions[top * 3 + 1]! - SKIRT;
        positions[v * 3 + 2] = positions[top * 3 + 2]!;
        normals[v * 3] = normals[top * 3]!;
        normals[v * 3 + 1] = normals[top * 3 + 1]!;
        normals[v * 3 + 2] = normals[top * 3 + 2]!;
        steep[v] = steep[top]!;
        v++;
      }
      for (let e = 0; e < PATCH; e++) {
        const t0 = corner(...edge[e]!), t1 = corner(...edge[e + 1]!);
        const h0 = hung + e, h1 = hung + e + 1;
        indices[w++] = t0; indices[w++] = h0; indices[w++] = t1;
        indices[w++] = t1; indices[w++] = h0; indices[w++] = h1;
        indices[w++] = t0; indices[w++] = t1; indices[w++] = h0;
        indices[w++] = t1; indices[w++] = h1; indices[w++] = h0;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aSteep', new Float32BufferAttribute(steep, 1));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  const heightAt = (tile: number, a: number, b: number): number => {
    const ia = Math.min(PATCH - 1, Math.max(0, Math.floor(a))), ib = Math.min(PATCH - 1, Math.max(0, Math.floor(b)));
    const u = a - ia, v = b - ib, o = tile * SIDE * SIDE;
    const h00 = corners[o + ib * SIDE + ia]!, h10 = corners[o + ib * SIDE + ia + 1]!;
    const h01 = corners[o + (ib + 1) * SIDE + ia]!, h11 = corners[o + (ib + 1) * SIDE + ia + 1]!;
    // The two triangles of the cell as indexed above (p00 p10 p01, p10 p11 p01).
    return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  };
  return { geometry, low, high, heightAt };
}
