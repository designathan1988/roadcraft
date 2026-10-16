import { PLATE_SIZE } from '@world/bounds';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';
import { keepCellAt, keepCellRect } from './cellKeeps';
import type { ForestSpecies } from './groundCover';
import { seedOfKind } from './natureTrees';
import { TERRAIN_HALF } from './terrain';

/** THE PAINTED COVERS' AND THE RIVERS' PLACES, ONE KEEP CELL AT A TIME (`cellKeeps.ts`) */

/** A place a plant or a stone may stand (`CandidateKeep` keeps those that do). */
export interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly yaw: number;
  readonly seed: number;
  readonly species: ForestSpecies;
}

/** A stone of a river's bed or bank: kept by its height over the water, read on the ground as drawn. */
export interface ShoreCandidate extends Candidate {
  readonly level: number;
  /** Its cell's draw against the odds of its height over the water. */
  readonly draw: number;
}

/** What a sweep reads of the ground: the painted covers' densities (0..1) and the water's level at a point. */
export interface CoverField {
  forestAt(x: number, y: number): number;
  coverAt(kind: 'scrub' | 'rocks', x: number, y: number): number;
  shoreLevelAt(x: number, y: number): number | null;
}

/** A tree every twelve metres at the most where a wood is painted: the player wants few trees, not woods filling the map */
const FOREST_SPACING = m(12);
/** Low scrub (`world/terrainPaint.ts` 'scrub'): close-set low-poly bushes of a metre to two and a half, no trees */
const SCRUB_SPACING = m(2.4);
/** The stones: where rocks were painted, one candidate a cell of ROCK_SPACING kept by the density */
const ROCK_SPACING = m(3.2);
const RIVER_ROCK_SPACING = m(3);
/** How far past the water's box its stones are looked for. */
const SHORE_REACH = m(12);
/** How far past the water's box a change of the water reaches a stone's cell: the reach and a lattice cell. */
export const SHORE_SWEEP_PAD = SHORE_REACH + RIVER_ROCK_SPACING;
/** How far a dab's change of the covers reaches a place: a cover cell (8 m, `terrain.ts` FOREST_RES) and the widest jitter */
export const COVER_SWEEP_PAD = m(8) + FOREST_SPACING * 0.45;

/** A cell's hash in 0..1: the same wherever a placement asks it, so an edit elsewhere never moves a plant. */
export const cellHash = (a: number, b: number, salt: number): number => {
  let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(salt, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

/** -1..1 value noise of about 25 m: where scrub gathers into thickets. */
function scrubClump(x: number, y: number): number {
  const s = m(25);
  const gx = x / s, gy = y / s;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number): number => {
    let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ 0x51b;
    v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
    return ((v ^ (v >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const bottom = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Whether lattice cell (i, j) of `spacing` lies whole inside one plate: the painted covers' lattice stops at each plate's edge. */
function insidePlate(i: number, j: number, spacing: number): boolean {
  const x0 = -TERRAIN_HALF + i * spacing, y0 = -TERRAIN_HALF + j * spacing;
  // The plate under the cell's middle (`world/bounds.ts`): its centre worked out, no object a cell.
  const cx = Math.floor((x0 + spacing / 2) / PLATE_SIZE + 0.5) * PLATE_SIZE, cy = Math.floor((y0 + spacing / 2) / PLATE_SIZE + 0.5) * PLATE_SIZE;
  const half = PLATE_SIZE / 2;
  return x0 >= cx - half && x0 + spacing <= cx + half
    && y0 >= cy - half && y0 + spacing <= cy + half;
}

/** The lattice cells of `spacing` (anchored at -TERRAIN_HALF) a rectangle reaches: [i0, i1, j0, j1]. */
function latticeOver(rect: ChangeRect, spacing: number): [number, number, number, number] {
  return [
    Math.floor((rect[0] + TERRAIN_HALF) / spacing), Math.floor((rect[2] + TERRAIN_HALF) / spacing),
    Math.floor((rect[1] + TERRAIN_HALF) / spacing), Math.floor((rect[3] + TERRAIN_HALF) / spacing),
  ];
}


/** The painted woods' trees (`world/terrainPaint.ts` 'forest') standing in keep cell `key`. */
export function forestIn(key: number, field: CoverField): Candidate[] {
  const cell = keepCellRect(key);
  const out: Candidate[] = [];
  const [i0, i1, j0, j1] = latticeOver(cell, FOREST_SPACING);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = -TERRAIN_HALF + (i + 0.5) * FOREST_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * FOREST_SPACING;
      const density = field.forestAt(cx, cy);
      if (density < 0.04 || cellHash(i, j, 1) > density * 0.92) continue;
      const x = cx + (cellHash(i, j, 2) - 0.5) * FOREST_SPACING * 0.9, y = cy + (cellHash(i, j, 3) - 0.5) * FOREST_SPACING * 0.9;
      if (keepCellAt(x, y) !== key || !insidePlate(i, j, FOREST_SPACING)) continue;
      const h = m(10) + m(8) * cellHash(i, j, 4) * (0.6 + 0.4 * density);
      // A wood is green: broadleaf with some conifers.
      const roll = cellHash(i, j, 13);
      const species = roll < 0.45 ? 'broadleaf' : roll < 0.82 ? 'broadleafTall' : 'conifer';
      const kind = roll < 0.5 ? 'oak' : roll < 0.9 ? 'cypress' : 'palm';
      out.push({ x, y, size: h, yaw: cellHash(i, j, 5) * Math.PI * 2, seed: seedOfKind(kind, cellHash(i, j, 6)), species });
    }
  }
  return out;
}

/** The low scrub ('scrub') standing in keep cell `key`. */
export function scrubIn(key: number, field: CoverField): Candidate[] {
  const cell = keepCellRect(key);
  const out: Candidate[] = [];
  const [i0, i1, j0, j1] = latticeOver(cell, SCRUB_SPACING);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = -TERRAIN_HALF + (i + 0.5) * SCRUB_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * SCRUB_SPACING;
      const density = field.coverAt('scrub', cx, cy);
      if (density < 0.04) continue;
      const clump = 0.35 + 0.65 * Math.max(0, Math.min(1, (scrubClump(cx, cy) + 0.15) * 1.6));
      if (cellHash(i, j, 21) > Math.sqrt(density) * clump) continue;
      const x = cx + (cellHash(i, j, 22) - 0.5) * SCRUB_SPACING * 0.95, y = cy + (cellHash(i, j, 23) - 0.5) * SCRUB_SPACING * 0.95;
      if (keepCellAt(x, y) !== key || !insidePlate(i, j, SCRUB_SPACING)) continue;
      out.push({ x, y, size: m(1.5) + m(2) * cellHash(i, j, 24) * clump, yaw: cellHash(i, j, 26) * Math.PI * 2, seed: cellHash(i, j, 27), species: 'broadleaf' });
    }
  }
  return out;
}

/** The painted stones ('rocks') lying in keep cell `key`. */
export function rocksIn(key: number, field: CoverField): Candidate[] {
  const cell = keepCellRect(key);
  const out: Candidate[] = [];
  const [i0, i1, j0, j1] = latticeOver(cell, ROCK_SPACING);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = -TERRAIN_HALF + (i + 0.5) * ROCK_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * ROCK_SPACING;
      const density = field.coverAt('rocks', cx, cy);
      if (density < 0.04 || cellHash(i, j, 41) > Math.sqrt(density) * 0.7) continue;
      const x = cx + (cellHash(i, j, 42) - 0.5) * ROCK_SPACING * 0.9, y = cy + (cellHash(i, j, 43) - 0.5) * ROCK_SPACING * 0.9;
      if (keepCellAt(x, y) !== key || !insidePlate(i, j, ROCK_SPACING)) continue;
      // Mostly modest stones, now and then a big boulder.
      const roll = cellHash(i, j, 44);
      const size = roll > 0.88 ? m(2.2) + m(2) * cellHash(i, j, 45) : m(0.6) + m(1.5) * roll;
      out.push({ x, y, size, yaw: cellHash(i, j, 46) * Math.PI * 2, seed: cellHash(i, j, 47), species: 'broadleaf' });
    }
  }
  return out;
}

/** The world box the water covers (`TerrainSurface.waterArea`). */
export interface WaterBox { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }

/** The places a stone may lie along the water - in the shallows, on the line and up the bank - in keep cell `key`. */
export function shoreIn(key: number, field: CoverField, water: WaterBox | null): ShoreCandidate[] {
  const out: ShoreCandidate[] = [];
  if (!water) return out;
  const cell = keepCellRect(key);
  // The lattice over the water's box (and a reach round it), as far as this cell takes in.
  const s = RIVER_ROCK_SPACING;
  const i0 = Math.max(Math.floor((water.minX - SHORE_REACH + TERRAIN_HALF) / s), Math.floor((cell[0] + TERRAIN_HALF) / s) - 1);
  const i1 = Math.min(Math.ceil((water.maxX + SHORE_REACH + TERRAIN_HALF) / s), Math.floor((cell[2] + TERRAIN_HALF) / s));
  const j0 = Math.max(Math.floor((water.minY - SHORE_REACH + TERRAIN_HALF) / s), Math.floor((cell[1] + TERRAIN_HALF) / s) - 1);
  const j1 = Math.min(Math.ceil((water.maxY + SHORE_REACH + TERRAIN_HALF) / s), Math.floor((cell[3] + TERRAIN_HALF) / s));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = -TERRAIN_HALF + (i + cellHash(i, j, 51)) * s, y = -TERRAIN_HALF + (j + cellHash(i, j, 52)) * s;
      if (keepCellAt(x, y) !== key) continue;
      const level = field.shoreLevelAt(x, y);
      if (level === null) continue;
      const size = m(0.6) + m(1.6) * cellHash(i, j, 54) ** 1.6;
      out.push({ x, y, level, draw: cellHash(i, j, 53), size, yaw: cellHash(i, j, 55) * Math.PI * 2, seed: cellHash(i, j, 56), species: 'broadleaf' });
    }
  }
  return out;
}

/** Two places the same: a cell swept again to the same places keeps them as they stand. */
export const sameCandidate = (a: Candidate, b: Candidate): boolean =>
  a.x === b.x && a.y === b.y && a.size === b.size && a.yaw === b.yaw && a.seed === b.seed && a.species === b.species;
export const sameShore = (a: ShoreCandidate, b: ShoreCandidate): boolean => sameCandidate(a, b) && a.level === b.level && a.draw === b.draw;
