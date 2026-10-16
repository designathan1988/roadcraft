import { describe, expect, it } from 'vitest';

import { MAP_REGIONS } from '@world/bounds';
import { keepCellsOver } from '@render/cellKeeps';
import { COVER_SWEEP_PAD, SHORE_SWEEP_PAD, cellHash, forestIn, rocksIn, scrubIn, shoreIn, type Candidate, type CoverField } from '@render/coverSweep';
import { TERRAIN_HALF } from '@render/terrain';

/** A disc of painted cover, as a dab lays it. */
interface Disc { readonly x: number; readonly y: number; readonly r: number }
const inside = (discs: readonly Disc[], x: number, y: number): boolean => discs.some((d) => Math.hypot(x - d.x, y - d.y) < d.r);

/** A field with covers painted in discs and water in a box, counting what is asked of it. */
function fieldOf(discs: readonly Disc[], water: { minX: number; maxX: number; minY: number; maxY: number } | null): CoverField & { asked: number } {
  const field = {
    asked: 0,
    forestAt(x: number, y: number): number { field.asked++; return inside(discs, x, y) ? 0.8 : 0; },
    coverAt(_kind: 'scrub' | 'rocks', x: number, y: number): number { field.asked++; return inside(discs, x, y) ? 0.7 : 0; },
    shoreLevelAt(x: number, y: number): number | null {
      field.asked++;
      return water && x >= water.minX - 6 && x <= water.maxX + 6 && y >= water.minY - 6 && y <= water.maxY + 6 ? 2 : null;
    },
  };
  return field;
}

/** The forest as the whole sweep laid it before (`renderer.ts` `coverSweep`, `paintedCells`): the reference. */
function wholeForest(discs: readonly Disc[], field: CoverField): Candidate[] {
  const spacing = 12;
  const area = discs.reduce<[number, number, number, number] | null>((a, d) => {
    const b: [number, number, number, number] = [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r];
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
  }, null);
  const out: Candidate[] = [];
  if (!area) return out;
  for (const plate of MAP_REGIONS) {
    const first = Math.ceil((plate.cx - plate.half + TERRAIN_HALF) / spacing);
    const last = Math.floor((plate.cx + plate.half + TERRAIN_HALF) / spacing) - 1;
    const firstY = Math.ceil((plate.cy - plate.half + TERRAIN_HALF) / spacing);
    const lastY = Math.floor((plate.cy + plate.half + TERRAIN_HALF) / spacing) - 1;
    const i0 = Math.max(first, Math.floor((area[0] + TERRAIN_HALF) / spacing)), i1 = Math.min(last, Math.floor((area[2] + TERRAIN_HALF) / spacing));
    const j0 = Math.max(firstY, Math.floor((area[1] + TERRAIN_HALF) / spacing)), j1 = Math.min(lastY, Math.floor((area[3] + TERRAIN_HALF) / spacing));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = -TERRAIN_HALF + (i + 0.5) * spacing, cy = -TERRAIN_HALF + (j + 0.5) * spacing;
      const density = field.forestAt(cx, cy);
      if (density < 0.04 || cellHash(i, j, 1) > density * 0.92) continue;
      const x = cx + (cellHash(i, j, 2) - 0.5) * spacing * 0.9, y = cy + (cellHash(i, j, 3) - 0.5) * spacing * 0.9;
      out.push({ x, y, size: 0, yaw: 0, seed: 0, species: 'broadleaf' });
    }
  }
  return out;
}

const where = (list: readonly { x: number; y: number }[]): string[] => list.map((c) => `${c.x.toFixed(6)},${c.y.toFixed(6)}`).sort();

/** The cells a list of discs reaches, as the renderer sweeps them (`sweepAllCovers`). */
const cellsOf = (discs: readonly Disc[]): Set<number> => {
  const cells = new Set<number>();
  for (const d of discs) keepCellsOver([d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r], COVER_SWEEP_PAD, cells);
  return cells;
};

/** THE PAINTED COVERS SWEPT CELL BY CELL (`coverSweep.ts`): the same places the whole sweep laid, at a cell's cost */
describe('the painted covers swept cell by cell', () => {
  // One wood in a plate, one across the edge between two plates (x = 1024), one far off.
  const discs: Disc[] = [{ x: 200, y: -150, r: 70 }, { x: 1024, y: 300, r: 50 }, { x: -3000, y: 2500, r: 40 }];

  it('lays the same trees as the whole sweep did, the plates\' edges included', () => {
    const field = fieldOf(discs, null);
    const reference = wholeForest(discs, field);
    expect(reference.length).toBeGreaterThan(20);
    const swept: Candidate[] = [];
    for (const key of cellsOf(discs)) swept.push(...forestIn(key, field));
    expect(where(swept)).toEqual(where(reference));
  });

  it('puts each place in one cell only', () => {
    const field = fieldOf(discs, null);
    for (const sweep of [forestIn, scrubIn, rocksIn]) {
      const seen = new Set<string>();
      let all = 0;
      for (const key of cellsOf(discs)) for (const c of sweep(key, field)) { seen.add(`${c.x},${c.y}`); all++; }
      expect(all).toBeGreaterThan(0);
      expect(seen.size).toBe(all);
    }
  });

  it('reads the ground of one cell for one cell, however much is painted', () => {
    const asked = (painted: readonly Disc[]): number => {
      const field = fieldOf(painted, null);
      const key = [...cellsOf([painted[0]!])][0]!;
      field.asked = 0;
      forestIn(key, field); scrubIn(key, field); rocksIn(key, field);
      return field.asked;
    };
    const many = Array.from({ length: 400 }, (_, k) => ({ x: -4000 + (k % 20) * 400, y: -4000 + Math.floor(k / 20) * 400, r: 90 }));
    expect(asked(many)).toBe(asked([many[0]!]));
    // A 64 m cell: some 7 x 7 trees' lattice, 28 x 28 bushes', 21 x 21 stones'.
    expect(asked(many)).toBeLessThan(1_500);
  });

  it('finds the rivers\' stones in a cell only along the water', () => {
    const water = { minX: 0, maxX: 300, minY: 0, maxY: 20 };
    const field = fieldOf([], water);
    const cells = keepCellsOver([water.minX, water.minY, water.maxX, water.maxY], SHORE_SWEEP_PAD, new Set());
    let stones = 0;
    for (const key of cells) for (const s of shoreIn(key, field, water)) {
      stones++;
      expect(s.x).toBeGreaterThanOrEqual(water.minX - 12 - 3);
      expect(s.y).toBeLessThanOrEqual(water.maxY + 12 + 3);
    }
    expect(stones).toBeGreaterThan(100);
    expect(shoreIn([...cells][0]!, field, null)).toEqual([]);
  });
});
