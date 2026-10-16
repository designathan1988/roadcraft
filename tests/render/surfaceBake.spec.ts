import { describe, expect, it } from 'vitest';

import { LOOKS } from '../../src/render/bake/finishRecipes';
import { roadRecipes } from '../../src/render/bake/roadRecipes';
import { terrainRecipes } from '../../src/render/bake/terrainRecipes';
import { fbm, makeNoise, surfaceTexels, type SurfaceRecipe } from '../../src/render/mesh/textureBaker';

/** The in-game canvas bake as it was (`textureBaker.ts` `bakeSurface`, `normalMapFrom`, `grayscaleCanvas` at 3adccde), on the arrays `createImageData` hands out: alpha 255, so the canvas kept every byte. */
function oldCanvasBake(recipe: SurfaceRecipe): { map: Uint8ClampedArray; normal: Uint8ClampedArray; rough: Uint8ClampedArray } {
  const size = recipe.size;
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = recipe.metallic ? new Float32Array(size * size) : undefined;
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.9, metal: 0 };
  const map = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.metal = 0;
      recipe.shade(x, y, out);
      const index = y * size + x;
      map[index * 4] = Math.round(Math.min(1, Math.max(0, out.r)) * 255);
      map[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, out.g)) * 255);
      map[index * 4 + 2] = Math.round(Math.min(1, Math.max(0, out.b)) * 255);
      map[index * 4 + 3] = 255;
      height[index] = out.h;
      rough[index] = out.rough;
      if (metal) metal[index] = out.metal;
    }
  }
  const normal = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const above = (y === 0 ? size - 1 : y - 1) * size;
    const below = (y + 1 === size ? 0 : y + 1) * size;
    let left = size - 1;
    for (let x = 0; x < size; x++) {
      const right = x + 1 === size ? 0 : x + 1;
      const dx = ((height[row + right] as number) - (height[row + left] as number)) * recipe.relief;
      const dy = ((height[below + x] as number) - (height[above + x] as number)) * recipe.relief;
      left = x;
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const index = (y * size + x) * 4;
      normal[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      normal[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      normal[index + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      normal[index + 3] = 255;
    }
  }
  const roughTexels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < rough.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, rough[i] as number)) * 255);
    roughTexels[i * 4] = v;
    roughTexels[i * 4 + 1] = v;
    roughTexels[i * 4 + 2] = metal ? Math.round(Math.min(1, Math.max(0, metal[i] as number)) * 255) : v;
    roughTexels[i * 4 + 3] = 255;
  }
  return { map, normal, rough: roughTexels };
}

/** The old road bake's per-slab hash (`materials.ts` `cellHash` at 3adccde). */
function oldCellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** The road's asphalt colour and, written beside it, the raised crossings' (`materials.ts` `asphaltBake` and its `raisedPixels` at 3adccde). */
function oldAsphalt(): { road: Uint8ClampedArray; raised: Uint8ClampedArray } {
  const grain = makeNoise(0x51ed);
  const macro = makeNoise(0x9a17);
  const patch = makeNoise(0x2b64);
  const oil = makeNoise(0x6d05);
  const size = 512;
  const road = new Uint8ClampedArray(size * size * 4);
  const raised = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const chips = fbm(grain, u * 128, v * 128, 128, 3);
      const wear = fbm(macro, u * 6, v * 6, 6, 4);
      const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
      const stain = fbm(oil, u * 14, v * 3, 14, 3);
      const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
      const stone = fbm(grain, u * 420 + 3, v * 420 + 9, 420, 1);
      const flecks = stone > 0.74 ? (stone - 0.74) * 0.5 : stone < 0.2 ? -0.02 : 0;
      const pu = Math.floor(u * 5), pv = Math.floor(v * 3);
      const patchy = oldCellHash(pu, pv, 0x91c) > 0.82 && (u * 5 - pu) > 0.15 && (u * 5 - pu) < 0.75 && (v * 3 - pv) > 0.2 && (v * 3 - pv) < 0.6;
      const tone = 0.215 + (chips - 0.5) * 0.055 + flecks + (wear - 0.5) * 0.04 + (repair > 0.74 ? 0.022 : 0) - (patchy ? 0.03 : 0) - drip;
      const raisedTone = 0.245 + (chips - 0.5) * 0.03 + (wear - 0.5) * 0.032 + (repair > 0.74 ? 0.018 : 0) - drip;
      const at = (y * size + x) * 4;
      road[at] = Math.round(Math.min(1, Math.max(0, tone * 1.0)) * 255);
      road[at + 1] = Math.round(Math.min(1, Math.max(0, tone * 1.01)) * 255);
      road[at + 2] = Math.round(Math.min(1, Math.max(0, tone * 1.05)) * 255);
      road[at + 3] = 255;
      raised[at] = Math.round(Math.min(1, Math.max(0, raisedTone)) * 255);
      raised[at + 1] = Math.round(Math.min(1, Math.max(0, raisedTone * 1.01)) * 255);
      raised[at + 2] = Math.round(Math.min(1, Math.max(0, raisedTone * 1.05)) * 255);
      raised[at + 3] = 255;
    }
  }
  return { road, raised };
}

/** Byte for byte, without a 262,144-entry diff on failure. */
function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): { length: boolean; firstDifference: number } {
  if (a.length !== b.length) return { length: false, firstDifference: -1 };
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { length: true, firstDifference: i };
  return { length: true, firstDifference: -1 };
}

const finishRecipe = (finish: keyof typeof LOOKS): SurfaceRecipe => {
  const look = LOOKS[finish];
  return { size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size), ...(look.metallic ? { metallic: true } : {}) };
};
const road = (key: string): SurfaceRecipe => roadRecipes().find((entry) => entry.key === key)!.recipe;

describe('the build-time surface bake', () => {
  // A few recipes of each family: the street's kerb, a plain and a metal-and-glass finish, the land's dirt
  const cases: readonly (readonly [string, () => SurfaceRecipe])[] = [
    ['kerb', () => road('kerb')],
    ['building-tile', () => finishRecipe('tile')],
    ['building-glass (metallic)', () => finishRecipe('glass')],
    ['terrain-dirt', () => terrainRecipes().dirt],
  ];
  for (const [name, recipe] of cases) {
    it(`bakes ${name} to the same texels as the in-game canvas bake did`, () => {
      const now = surfaceTexels(recipe());
      const before = oldCanvasBake(recipe());
      expect(sameBytes(now.map, before.map)).toEqual({ length: true, firstDifference: -1 });
      expect(sameBytes(now.normal, before.normal)).toEqual({ length: true, firstDifference: -1 });
      expect(sameBytes(now.rough, before.rough)).toEqual({ length: true, firstDifference: -1 });
    });
  }

  it('bakes the asphalt, and the raised crossings\' colour the road bake wrote beside it, as the old road bake did', () => {
    const before = oldAsphalt();
    expect(sameBytes(surfaceTexels(road('asphalt')).map, before.road)).toEqual({ length: true, firstDifference: -1 });
    expect(sameBytes(surfaceTexels(road('asphalt-raised')).map, before.raised)).toEqual({ length: true, firstDifference: -1 });
  });
});
