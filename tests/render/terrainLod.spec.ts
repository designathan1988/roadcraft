import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { cellDiagonal, cellHeight } from '@world/groundPatch';
import { LOD_LEVELS, LOD_PATCH, LandLevels } from '@render/terrainLevels';
import { LandLod, lodFragmentGlsl, lodVertexGlsl } from '@render/terrainLod';

/** A TERRAIN PLATE DRAWN BY ITS DISTANCE (`render/terrainLod.ts`, Strugar's CDLOD) */
const seg = 320, n = seg + 1, cell = 6.4, half = 1024;

/** A plate's corners from a field of its corner indices, and their diagonals (`cellDiagonal`). */
function plate(field: (i: number, j: number) => number): { heights: Float64Array; flip: Uint8Array; diagonals(): void } {
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + j * n] = field(i, j);
  const flip = new Uint8Array(seg * seg);
  const diagonals = (): void => {
    for (let cy = 0; cy < seg; cy++) for (let cx = 0; cx < seg; cx++) {
      flip[cx + cy * seg] = cellDiagonal(heights[cx + cy * n]!, heights[cx + (cy + 1) * n]!, heights[cx + 1 + (cy + 1) * n]!, heights[cx + 1 + cy * n]!);
    }
  };
  diagonals();
  return { heights, flip, diagonals };
}

describe('a plate\'s levels', () => {
  // Rough land: hills, bumps a few cells wide and a wall.
  const { heights, flip, diagonals } = plate((i, j) => 30 * Math.sin(i * 0.031) * Math.cos(j * 0.027) + 4 * Math.sin(i * 0.4 + j * 0.3) + (i > 150 && i < 154 ? 3 : 0));
  /** The full ground at a point (corner units), as the shader's `landSurface` reads it. */
  const fine = (x: number, y: number): number => {
    const ix = Math.min(seg - 1, Math.floor(x)), iy = Math.min(seg - 1, Math.floor(y));
    return cellHeight(heights[ix + iy * n]!, heights[ix + (iy + 1) * n]!, heights[ix + 1 + (iy + 1) * n]!, heights[ix + 1 + iy * n]!, x - ix, y - iy, flip[ix + iy * seg]!);
  };
  const levels = new LandLevels(seg);
  levels.markAll();
  levels.measure(heights, flip);

  it('bound how far each level stands off the full ground, whichever diagonal it is drawn with', () => {
    for (let level = 1; level < LOD_LEVELS; level++) {
      const step = 1 << level;
      let most = 0;
      // A dense sample of the plate: every quarter cell.
      for (let y = 0; y <= seg; y += 0.25) {
        for (let x = 0; x <= seg; x += 0.25) {
          const cx = Math.min(seg / step - 1, Math.floor(x / step)), cy = Math.min(seg / step - 1, Math.floor(y / step));
          const x0 = cx * step, y0 = cy * step;
          const a = heights[x0 + y0 * n]!, b = heights[x0 + (y0 + step) * n]!, c = heights[x0 + step + (y0 + step) * n]!, d = heights[x0 + step + y0 * n]!;
          const u = (x - x0) / step, v = (y - y0) / step;
          const h = fine(x, y);
          most = Math.max(most, Math.abs(cellHeight(a, b, c, d, u, v, 0) - h), Math.abs(cellHeight(a, b, c, d, u, v, 1) - h));
        }
      }
      expect(levels.worst[level]).toBeGreaterThanOrEqual(most - 1e-4);
      // A bound, not a guess: within a few times the true error.
      expect(levels.worst[level]).toBeLessThan(most * 4 + 0.01);
    }
    expect(levels.worst[0]).toBe(0);
  });

  it('measure again only where the ground moved, to the same numbers as a whole measure', () => {
    const local = new LandLevels(seg);
    local.markAll();
    local.measure(heights, flip);
    for (let j = 40; j <= 52; j++) for (let i = 70; i <= 90; i++) heights[i + j * n] = heights[i + j * n]! + 5;
    diagonals();
    local.markBox(70, 90, 40, 52);
    local.measure(heights, flip);
    const whole = new LandLevels(seg);
    whole.markAll();
    whole.measure(heights, flip);
    expect(Array.from(local.data)).toEqual(Array.from(whole.data));
    expect(Array.from(local.worst)).toEqual(Array.from(whole.worst));
  });
});

describe('the patches chosen for a camera', () => {
  // Rolling land: its levels' errors small enough for every level to be used in one view.
  const { heights: land, flip } = plate((i, j) => 20 * Math.sin(i * 0.011) * Math.cos(j * 0.009));
  const levels = new LandLevels(seg);
  levels.markAll();
  levels.measure(land, flip);
  const origin = { x: 0, y: 0 };
  const lod = new LandLod(levels, { seg, cell, half }, origin, { west: true, east: true, north: true, south: true });
  interface Patch { x: number; y: number; step: number; level: number }
  /** The patches a camera at `eye` looking at `at` is given. */
  const look = (eye: readonly [number, number, number], at: readonly [number, number, number], fov: number): { camera: PerspectiveCamera; patches: Patch[] } => {
    const camera = new PerspectiveCamera(fov, 16 / 9, 1, 100_000);
    camera.position.set(...eye);
    camera.lookAt(...at);
    camera.updateMatrixWorld();
    const count = lod.select(camera, 1080);
    const data = lod.geometry.getAttribute('aLodPatch').array as Float32Array;
    return { camera, patches: Array.from({ length: count }, (_, k) => ({ x: data[k * 4]!, y: data[k * 4 + 1]!, step: data[k * 4 + 2]!, level: data[k * 4 + 3]! })) };
  };
  /** The shader's morph of a corner (`landCorner`): its distance from the eye against its level's range. */
  const morphOf = (camera: PerspectiveCamera, level: number, i: number, j: number): number => {
    const p = { x: i * cell - half + origin.x, y: land[i + j * n]!, z: j * cell - half - origin.y };
    const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
    return Math.min(1, Math.max(0, (d - lod.morph[level * 2]!) * lod.morph[level * 2 + 1]!));
  };
  /** Each cell's level, -1 where no patch was drawn (out of view); no cell drawn twice. */
  const levelsOf = (patches: readonly Patch[]): Int8Array => {
    const at = new Int8Array(seg * seg).fill(-1);
    for (const p of patches) {
      const span = LOD_PATCH * p.step;
      for (let j = p.y; j < p.y + span; j++) {
        for (let i = p.x; i < p.x + span; i++) {
          expect(at[i + j * seg]).toBe(-1);
          at[i + j * seg] = p.level;
        }
      }
    }
    return at;
  };

  it('sends the patches only when the choice changed: the same camera twice sends none the second time', () => {
    const attribute = lod.geometry.getAttribute('aLodPatch') as import('three').InstancedBufferAttribute;
    look([-900, 40, 900], [600, 0, -700], 35);
    // As if three sent them.
    attribute.clearUpdateRanges();
    const version = attribute.version;
    const { patches } = look([-900, 40, 900], [600, 0, -700], 35);
    expect(patches.length).toBeGreaterThan(0);
    expect(attribute.version).toBe(version);
    expect(attribute.updateRanges.length).toBe(0);
    // Another view: sent again, from the first patch that differs.
    look([-700, 260, 500], [-700, 0, 500], 170);
    expect(attribute.version).toBeGreaterThan(version);
    expect(attribute.updateRanges.length).toBe(1);
  });

  it('cover the plate once, every level in use, from over it', () => {
    const { patches } = look([-700, 260, 500], [-700, 0, 500], 170);
    expect(levelsOf(patches).every((l) => l >= 0)).toBe(true);
    expect(new Set(patches.map((p) => p.level)).size).toBeGreaterThan(2);
  });

  const views: readonly (readonly [string, readonly [number, number, number], readonly [number, number, number], number])[] = [
    ['over the plate', [-700, 260, 500], [-700, 0, 500], 170],
    ['low over the ground, looking across', [-900, 40, 900], [600, 0, -700], 35],
    ['far off the plate', [3000, 600, -2500], [0, 0, 0], 35],
  ];
  for (const [name, eye, at, fov] of views) {
    it(`meet without a crack, ${name}: one level apart, the finer morphed whole and the coarser not at all along their edge (Strugar)`, () => {
      const { camera, patches } = look(eye, at, fov);
      const levelAt = levelsOf(patches);
      let edges = 0;
      // Cell (i, j) against its east and its south neighbour; the shared edge's two corners.
      for (const [di, dj] of [[1, 0], [0, 1]] as const) {
        for (let j = 0; j + dj < seg; j++) {
          for (let i = 0; i + di < seg; i++) {
            const a = levelAt[i + j * seg]!, b = levelAt[i + di + (j + dj) * seg]!;
            if (a === b || a < 0 || b < 0) continue;
            expect(Math.abs(a - b)).toBe(1);
            const finer = Math.min(a, b), coarser = finer + 1;
            for (const [x, y] of [[i + di, j + dj], [i + 1, j + 1]] as const) {
              expect(morphOf(camera, finer, x, y)).toBe(1);
              expect(morphOf(camera, coarser, x, y)).toBe(0);
            }
            edges++;
          }
        }
      }
      expect(edges).toBeGreaterThan(0);
    });
  }

  it('read the ground in each pixel as the page reads it (`cellHeight`), split along the drawn diagonal', () => {
    const glsl = lodFragmentGlsl({ seg, cell, half });
    // The shader's weights of corners a, b, c, d, as written in it.
    const lines = [
      '? (u >= v ? vec4(1.0 - u, 0.0, v, u - v) : vec4(1.0 - v, v - u, u, 0.0))',
      ': (u + v <= 1.0 ? vec4(1.0 - u - v, v, 0.0, u) : vec4(0.0, 1.0 - u, u + v - 1.0, 1.0 - v));',
    ];
    for (const line of lines) expect(glsl).toContain(line);
    const weights = (u: number, v: number, flipped: boolean): number[] => flipped
      ? (u >= v ? [1 - u, 0, v, u - v] : [1 - v, v - u, u, 0])
      : (u + v <= 1 ? [1 - u - v, v, 0, u] : [0, 1 - u, u + v - 1, 1 - v]);
    let seed = 3;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 2000; k++) {
      const a = random() * 20, b = random() * 20, c = random() * 20, d = random() * 20, u = random(), v = random();
      for (const flipped of [0, 1]) {
        const w = weights(u, v, flipped === 1);
        expect(w[0]! * a + w[1]! * b + w[2]! * c + w[3]! * d).toBeCloseTo(cellHeight(a, b, c, d, u, v, flipped), 9);
      }
    }
    // And the vertex shader's diagonal is the page's rule (`cellDiagonal`).
    expect(lodVertexGlsl({ seg, cell, half })).toContain('abs(pa.y - pc.y) + 0.5 < abs(pb.y - pd.y)');
  });

  it('hang a rim only on the plate\'s own edges', () => {
    const { patches } = look([-700, 260, 500], [-700, 0, 500], 170);
    // One rim a side of the plate a patch lies on (a corner patch two).
    const onEdge = patches.reduce((n, p) => n + [p.x === 0, p.y === 0, p.x + LOD_PATCH * p.step === seg, p.y + LOD_PATCH * p.step === seg].filter(Boolean).length, 0);
    expect(lod.rimGeometry.instanceCount).toBe(onEdge);
  });
});
