import { computeEcology, type NatureSettings } from '@world/ecology';
import { reliefHeight, type ReliefVersion } from '@world/terrain';
import { m } from '@world/units';
import { natureDensity } from './natureNoise';
import { WOODS_SLOPE_STEP, WOODS_SPACING } from './woodsBase';

/** THE WOODS OF A PLATE NOT DRAWN IN FULL (`farForest.ts`) */

/** The terrain's corners per plate side, the cell between them, the plate's half side (`terrain.ts` GRID, TERRAIN_CELL, TERRAIN_HALF). */
export interface FarWoodsGrid {
  readonly side: number;
  readonly cell: number;
  readonly half: number;
  /** The level added to the land (`TERRAIN_BASE`). */
  readonly base: number;
  /** Quads along a side of the far ground's patch of a plate (`flatAtlas.ts` FAR_QUADS): the trees stand on it. */
  readonly farQuads: number;
}

export interface FarWoodsAsk {
  readonly relief: ReliefVersion;
  readonly nature: NatureSettings;
  readonly cx: number;
  readonly cy: number;
  readonly grid: FarWoodsGrid;
}

/** One plate's far trees, as parallel arrays (transferred from the worker, not copied). */
export interface FarWoods {
  readonly count: number;
  /** World position: x east, y north, z up (on the far ground's patch). */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Height, world units. */
  readonly size: Float32Array;
  readonly yaw: Float32Array;
  /** The tree's seed (`natureTrees.ts` seedOfKind): its model and its tint. */
  readonly seed: Float32Array;
  /** Its cell's hash over its band's odds: it stands while this is under the woods' scale. */
  readonly pick: Float32Array;
  /** The plate's sum of the bands' odds over its lattice (the near sweep's `plate.sum`). */
  readonly planned: number;
  /** The lattice's cells read: the work of one plate, the same on any plate of any map. */
  readonly work: number;
}

/** The woods the ecosystem grows at full vegetation, per 1920 m square (`renderer.ts` NATURE_TREES). */
export const FAR_WOODS_BUDGET = 2_500;
const BUDGET_AREA = m(1_920) ** 2;
/** Trees kept past the plate's own scale: room for the map's scale, an average over the plates, to be larger. */
const HEADROOM = 1.3;
/** The trees' models, in seed order (`natureTrees.ts` TREE_MODELS): oak, oak, cypress, cypress, palm, palm. */
const MODELS = 6;
const SLOTS: Readonly<Record<'oak' | 'cypress' | 'palm', readonly number[]>> = { oak: [0, 1], cypress: [2, 3], palm: [4, 5] };

/** A cell's hash in 0..1 (`renderer.ts` cellHash): the same numbers, so the far trees are the near ones. */
function cellHash(a: number, b: number, salt: number): number {
  let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(salt, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** `natureTrees.ts` seedOfKind, without its `three`: a seed (0..1) that grows as this kind, `r` choosing among its models. */
function seedOf(kind: 'oak' | 'cypress' | 'palm', r: number): number {
  const slots = SLOTS[kind];
  const slot = slots[Math.min(slots.length - 1, Math.floor(r * slots.length))]!;
  return (slot + 0.05 + ((r * 7.31) % 1) * 0.9) / MODELS;
}

/** The woods' scale at which a plate grows its budget (`renderer.ts` natureSweep treeScale), from the plates' average `planned`. */
export function woodsScale(planned: number, half: number, budget = FAR_WOODS_BUDGET): number {
  const perArea = planned * (BUDGET_AREA / (2 * half) ** 2);
  // In steps of 2 %, as the near sweep: a nudge no eye can see changes nothing.
  return Math.min(1, Math.exp(Math.round(Math.log(budget / Math.max(1, perArea)) / 0.02) * 0.02));
}

/** Works out one plate's far trees. */
export function farWoods(ask: FarWoodsAsk): FarWoods {
  const { relief, nature, cx, cy } = ask;
  const { side, cell, half, base, farQuads } = ask.grid;
  // The natural land at the terrain's corners, rows from the north edge (as `flatGround.worker.ts`).
  const heights = new Float64Array(side * side);
  for (let j = 0; j < side; j++) {
    const y = cy + half - j * cell;
    for (let i = 0; i < side; i++) heights[j * side + i] = base + reliefHeight(relief, cx - half + i * cell, y);
  }
  const zeros = new Float32Array(side * side);
  const field = computeEcology({ side, cell, heights, water: new Uint8Array(side * side), sandstone: zeros, basalt: zeros, painted: null, settings: nature });
  // The land between corners, bilinear (the woods' slope reads it as the near sweep reads the plate's).
  const seg = side - 1;
  const natural = (x: number, y: number): number => {
    if (!(x >= -half && x <= half && y >= -half && y <= half)) return base + reliefHeight(relief, cx + x, cy + y);
    const gx = (x + half) / cell, gy = (half - y) / cell;
    const i = Math.min(seg - 1, Math.floor(gx)), j = Math.min(seg - 1, Math.floor(gy));
    const u = gx - i, v = gy - j, k = j * side + i;
    return (heights[k]! * (1 - u) + heights[k + 1]! * u) * (1 - v) + (heights[k + side]! * (1 - u) + heights[k + side + 1]! * u) * v;
  };
  // The far ground's patch the trees stand on (`flatAtlas.ts` buildFlatFar): the same heights, the same split of each quad.
  const farSide = farQuads + 1, step = (2 * half) / farQuads;
  const far = new Float64Array(farSide * farSide);
  for (let j = 0; j < farSide; j++) for (let i = 0; i < farSide; i++) far[j * farSide + i] = base + reliefHeight(relief, cx - half + i * step, cy - half + j * step);
  const farGround = (x: number, y: number): number => {
    const gx = Math.min(farQuads - 1e-6, Math.max(0, (x + half) / step)), gy = Math.min(farQuads - 1e-6, Math.max(0, (y + half) / step));
    const i = Math.floor(gx), j = Math.floor(gy), u = gx - i, v = gy - j;
    const h00 = far[j * farSide + i]!, h10 = far[j * farSide + i + 1]!, h01 = far[(j + 1) * farSide + i]!, h11 = far[(j + 1) * farSide + i + 1]!;
    return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };

  const spacing = WOODS_SPACING, d = WOODS_SLOPE_STEP;
  const cells = Math.floor((2 * half) / spacing);
  const odds = new Float32Array(cells * cells);
  const band = new Uint8Array(cells * cells);
  let planned = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = -half + (i + 0.5) * spacing, y = -half + (j + 0.5) * spacing;
      const ix = Math.round((x + half) / cell), iy = Math.round((half - y) / cell);
      const k = iy * field.side + ix;
      const ecology = Math.min(1, (field.canopy[k] ?? 0) * 0.9 + (field.trees[k] ?? 0) * 0.5 + (field.emergent[k] ?? 0) * 0.3);
      const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
      const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
      const density = natureDensity(x + cx, y + cy, m(1), hillside, ecology);
      const o = j * cells + i;
      // The bands (`natureSweep`): inner forest, its edge, scattered trees, a rare lone one.
      if (density > 0.62) { odds[o] = 0.92; band[o] = 3; }
      else if (density > 0.5) { odds[o] = 0.25 + (density - 0.5) / 0.12 * 0.6; band[o] = 2; }
      else if (density > 0.38) { odds[o] = 0.025; band[o] = 1; }
      else { odds[o] = 0.003; band[o] = 1; }
      planned += odds[o]!;
    }
  }
  const cap = Math.min(1, HEADROOM * woodsScale(planned, half));
  const di = Math.round(cx / spacing), dj = Math.round(cy / spacing);
  const list: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const o = j * cells + i, gi = i + di, gj = j + dj;
      const h = cellHash(gi, gj, 41);
      if (h >= odds[o]! * cap) continue;
      const x = -half + (i + 0.5 + (cellHash(gi, gj, 43) - 0.5) * 0.9) * spacing;
      const y = -half + (j + 0.5 + (cellHash(gi, gj, 44) - 0.5) * 0.9) * spacing;
      // Nothing of the ecosystem at the plate's very edge or on a cliff (`renderer.ts` natureOpen).
      if (Math.abs(x) > half - m(2) || Math.abs(y) > half - m(2)) continue;
      const g = m(2);
      if (Math.hypot(natural(x + g, y) - natural(x - g, y), natural(x, y + g) - natural(x, y - g)) / (2 * g) > 0.75) continue;
      const inner = band[o] === 3, edge = band[o] === 2;
      const size = inner ? m(11) + m(8) * cellHash(gi, gj, 45) : edge ? m(8) + m(6) * cellHash(gi, gj, 45) : m(5.5) + m(4) * cellHash(gi, gj, 45);
      const pick = cellHash(gi, gj, 49);
      const kind = pick < 0.55 ? 'oak' : pick < (inner ? 0.97 : 0.85) ? 'cypress' : 'palm';
      list.push(x, y, size, cellHash(gi, gj, 47) * Math.PI * 2, seedOf(kind, cellHash(gi, gj, 48)), h / odds[o]!);
    }
  }
  const count = list.length / 6;
  const out = {
    count, planned, work: cells * cells,
    x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count), size: new Float32Array(count),
    yaw: new Float32Array(count), seed: new Float32Array(count), pick: new Float32Array(count),
  };
  for (let n = 0; n < count; n++) {
    const lx = list[n * 6]!, ly = list[n * 6 + 1]!;
    out.x[n] = cx + lx;
    out.y[n] = cy + ly;
    out.z[n] = farGround(lx, ly);
    out.size[n] = list[n * 6 + 2]!;
    out.yaw[n] = list[n * 6 + 3]!;
    out.seed[n] = list[n * 6 + 4]!;
    out.pick[n] = list[n * 6 + 5]!;
  }
  return out;
}
