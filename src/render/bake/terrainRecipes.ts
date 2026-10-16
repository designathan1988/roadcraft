import { m } from '@world/units';
import { type SurfaceRecipe, fbm, makeNoise } from '../mesh/textureBaker';

/** The land's texture recipes (`terrain.ts`), baked at build time (`scripts/vite/surface-bake-plugin.ts`) */

/** 0..1 hash of an integer lattice point. */
function latticeHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ Math.imul(seed, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** Value noise tiling with its own period on each axis: a streak long down a face and narrow across it, still seamless */
function makeNoiseXY(seed: number): (x: number, y: number, px: number, py: number) => number {
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y, px, py) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const ax = ((x0 % px) + px) % px, ay = ((y0 % py) + py) % py;
    const bx = ax + 1 === px ? 0 : ax + 1, by = ay + 1 === py ? 0 : ay + 1;
    const a = latticeHash(ax, ay, seed), b = latticeHash(bx, ay, seed);
    const c = latticeHash(ax, by, seed), d = latticeHash(bx, by, seed);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** The nearest and second-nearest jittered points of an n x n tiling grid. */
const cell = { f1: 0, f2: 0, id: 0 };
function cellular(u: number, v: number, n: number, seed: number): typeof cell {
  const x = u * n, y = v * n;
  const ix = Math.floor(x), iy = Math.floor(y);
  cell.f1 = 9;
  cell.f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n;
      const px = cx + 0.12 + 0.76 * latticeHash(wx, wy, seed);
      const py = cy + 0.12 + 0.76 * latticeHash(wx, wy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < cell.f1) { cell.f2 = cell.f1; cell.f1 = d; cell.id = wy * n + wx; } else if (d < cell.f2) cell.f2 = d;
    }
  }
  return cell;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Mixes `out`'s colour towards an sRGB colour by `w`. */
function tintTowards(out: { r: number; g: number; b: number }, c: readonly [number, number, number], w: number): void {
  out.r += (c[0] - out.r) * w;
  out.g += (c[1] - out.g) * w;
  out.b += (c[2] - out.b) * w;
}

/** Texels across a rock layer; every layer of the array is this size. */
const ROCK_SIZE = 512;
/** World units one rock tile covers (`uRockScale`). */
export const ROCK_WORLD = m(23.2);

/** The rocks, two layers each - its FACE, read by the side projections of the triplanar mapping */
const ROCK_RECIPES: readonly (readonly [string, SurfaceRecipe])[] = (() => {
  const g1 = makeNoise(0x61a1), g2 = makeNoise(0x61d4), gs = makeNoiseXY(0x61b2), gf = makeNoise(0x61c3);
  const s1 = makeNoise(0x7a11), s2 = makeNoise(0x7a22), ss = makeNoiseXY(0x7a33);
  const b1 = makeNoise(0x8b11), bs = makeNoiseXY(0x8b22);
  const grey: readonly [number, number, number] = [0.46, 0.455, 0.44];
  const graniteFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const slab = fbm(g1, u * 4, v * 4, 4, 3);
    // Sheeting joints: long cracks across the face, gently curved, broken.
    const jt = v * 5 + (fbm(g2, u * 3, v * 3, 3, 2) - 0.5) * 0.9;
    const jd = Math.abs(jt - Math.round(jt)) * (ROCK_SIZE / 5);
    const joint = (1 - smoothstep(1.2, 3, jd)) * smoothstep(0.5, 0.62, fbm(g2, u * 7 + 3.3, v * 7 + 1.1, 7, 1));
    // And a few running down it.
    const ju = u * 3 + (fbm(g2, u * 2 + 9, v * 2, 2, 2) - 0.5) * 0.5;
    const ud = Math.abs(ju - Math.round(ju)) * (ROCK_SIZE / 3);
    const upright = (1 - smoothstep(1.2, 3, ud)) * smoothstep(0.52, 0.64, fbm(g2, u * 5 + 1.7, v * 5 + 6.1, 5, 1));
    const crack = Math.max(joint, upright);
    // Streaks: water and the cyanobacteria it feeds, down from every crest.
    const st = gs(u * 8, v * 2, 8, 2) * 0.7 + gs(u * 20 + 7, v * 4, 20, 4) * 0.3;
    const streak = smoothstep(0.52, 0.8, st);
    const groove = gs(u * 150, v * 3 + 1.7, 150, 3);
    const lichen = smoothstep(0.72, 0.82, fbm(gf, u * 20 + 5, v * 20 + 9, 20, 2)) * (1 - streak);
    const fine = fbm(gf, u * 96, v * 96, 96, 2);
    const crystal = latticeHash(x, y, 0x61e5);
    out.r = grey[0] - 0.03 + slab * 0.07;
    out.g = grey[1] - 0.025 + slab * 0.05;
    out.b = grey[2] - 0.015 + slab * 0.03;
    const k = (0.9 + fine * 0.18) * (0.98 + groove * 0.03) * (crystal < 0.06 ? 0.72 : crystal > 0.93 ? 1.16 : 1);
    out.r *= k; out.g *= k; out.b *= k;
    tintTowards(out, [0.3, 0.3, 0.3], streak * 0.35);
    tintTowards(out, [0.6, 0.61, 0.54], lichen * 0.35);
    out.r *= 1 - crack * 0.38; out.g *= 1 - crack * 0.38; out.b *= 1 - crack * 0.38;
    out.h = slab * 0.4 + groove * 0.18 - crack * 0.55 + fine * 0.12 + lichen * 0.05;
    out.rough = 0.86;
  };
  const graniteTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 6, 0x61f1);
    const crack = 1 - smoothstep(0.02, 0.07, c.f2 - c.f1);
    const block = latticeHash(c.id, 3, 0x61f2);
    const stain = smoothstep(0.58, 0.8, fbm(g1, u * 8 + 2, v * 8 + 7, 8, 3));
    const lichen = smoothstep(0.62, 0.72, fbm(gf, u * 24 + 1, v * 24 + 4, 24, 2));
    const fine = fbm(gf, u * 96 + 3, v * 96 + 8, 96, 2);
    const crystal = latticeHash(x, y, 0x61f3);
    const k = (0.88 + block * 0.16) * (0.9 + fine * 0.18) * (crystal < 0.06 ? 0.74 : crystal > 0.93 ? 1.14 : 1);
    out.r = grey[0] * k; out.g = grey[1] * k; out.b = grey[2] * k;
    tintTowards(out, [0.27, 0.27, 0.26], stain * 0.45);
    tintTowards(out, [0.64, 0.65, 0.57], lichen * 0.3);
    // Grit and soil caught in the joints.
    tintTowards(out, [0.3, 0.25, 0.19], crack * 0.85);
    out.h = 0.5 + block * 0.2 - crack * 0.5 + fine * 0.15;
    out.rough = 0.88;
  };
  const sand: readonly [number, number, number] = [0.68, 0.48, 0.33];
  const sandstoneFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    // Sets of cross-beds between level bounding surfaces, four to a tile.
    const setT = v * 4 + (fbm(s1, u * 2, v * 2, 2, 2) - 0.5) * 0.22;
    const setI = Math.floor(setT), setF = setT - setI;
    const setId = ((setI % 4) + 4) % 4;
    const slope = [9, -7, 12, -5][setId]!;
    const lam = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 40 + u * slope + fbm(s2, u * 6, v * 6, 6, 1) * 1.4));
    const bound = 1 - smoothstep(0.8, 2.4, Math.min(setF, 1 - setF) * (ROCK_SIZE / 4));
    const hard = latticeHash(setId, 1, 0x7a44);
    // Joints down the face, in pieces.
    const ju = u * 3 + (fbm(s2, u * 2 + 4, v * 2, 2, 2) - 0.5) * 0.35;
    const jd = Math.abs(ju - Math.round(ju)) * (ROCK_SIZE / 3);
    const joint = (1 - smoothstep(1, 2.6, jd)) * smoothstep(0.55, 0.68, fbm(s1, u * 6 + 2, v * 6 + 5, 6, 1));
    // Varnish hanging from the bed contacts (texture v runs down the face).
    const vs = ss(u * 8, v * 3, 8, 3) * 0.7 + ss(u * 20 + 3, v * 6, 20, 6) * 0.3;
    const varnish = smoothstep(0.5, 0.78, vs) * (0.3 + 0.7 * (1 - setF));
    const grain = fbm(s2, u * 128 + 7, v * 128 + 1, 128, 2);
    const speck = latticeHash(x, y, 0x7a55);
    const k = (0.94 + hard * 0.1) * (0.97 + lam * 0.06) * (0.92 + grain * 0.14) * (speck < 0.05 ? 0.86 : speck > 0.95 ? 1.08 : 1);
    out.r = sand[0] * k; out.g = sand[1] * k; out.b = sand[2] * k;
    tintTowards(out, [0.4, 0.27, 0.19], varnish * 0.3);
    out.r *= 1 - bound * 0.1 - joint * 0.3; out.g *= 1 - bound * 0.11 - joint * 0.32; out.b *= 1 - bound * 0.12 - joint * 0.33;
    out.h = 0.35 + hard * 0.3 + lam * 0.08 - bound * 0.3 - joint * 0.5 + grain * 0.12;
    out.rough = 0.93;
  };
  const sandstoneTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 5, 0x7a66);
    const edge = c.f2 - c.f1;
    const crack = 1 - smoothstep(0.015, 0.055, edge);
    const fill = (1 - smoothstep(0.05, 0.14, edge)) * (1 - crack);
    const block = latticeHash(c.id, 7, 0x7a77);
    const crust = fbm(s1, u * 10 + 3, v * 10 + 1, 10, 3);
    const grain = fbm(s2, u * 128 + 2, v * 128 + 9, 128, 2);
    const pit = latticeHash(x, y, 0x7a88) < 0.03 ? 1 : 0;
    const k = (0.9 + block * 0.14) * (0.9 + crust * 0.2) * (0.93 + grain * 0.12) * (1 - pit * 0.25);
    out.r = sand[0] * k; out.g = sand[1] * k; out.b = sand[2] * k;
    // Sand blown into the joints, paler; the joints themselves dark.
    tintTowards(out, [0.82, 0.7, 0.52], fill * 0.5);
    tintTowards(out, [0.36, 0.26, 0.19], crack * 0.8);
    tintTowards(out, [0.34, 0.33, 0.28], smoothstep(0.7, 0.8, fbm(s1, u * 22, v * 22 + 5, 22, 2)) * 0.5);
    out.h = 0.5 + block * 0.15 + crust * 0.15 - crack * 0.5 - fill * 0.15 + grain * 0.1;
    out.rough = 0.94;
  };
  const dark: readonly [number, number, number] = [0.4, 0.385, 0.37];
  const basaltFace = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    // Columns of uneven width, swaying a little as they rise.
    const cu = u * 9 + (bs(u * 9, v * 1.0, 9, 1) - 0.5) * 0.8 + (bs(u * 3 + 5, v * 2, 3, 2) - 0.5) * 0.4;
    const colI = Math.floor(cu), colF = cu - colI;
    const col = ((colI % 9) + 9) % 9;
    const ridge = 0.3 + 0.4 * latticeHash(col, 2, 0x8b33);
    const facet = 1 - Math.abs(colF - ridge) / Math.max(ridge, 1 - ridge);
    const gap = 1 - smoothstep(1, 2.6, Math.min(colF, 1 - colF) * (ROCK_SIZE / 9));
    // Cross joints at each column's own heights.
    const ct = v * 6 + latticeHash(col, 5, 0x8b44) * 3;
    const cd = Math.abs(ct - Math.round(ct)) * (ROCK_SIZE / 6);
    const cross = (1 - smoothstep(0.8, 2.2, cd)) * (latticeHash(col, Math.round(ct), 0x8b55) < 0.3 ? 1 : 0);
    const rust = smoothstep(0.6, 0.76, fbm(b1, u * 6 + 2, v * 6 + 9, 6, 3));
    const lichen = smoothstep(0.76, 0.86, fbm(b1, u * 18 + 5, v * 18 + 3, 18, 2));
    const streak = smoothstep(0.6, 0.85, bs(u * 40 + 3, v * 3, 40, 3));
    const grain = fbm(b1, u * 128, v * 128 + 4, 128, 2);
    const k = (0.86 + latticeHash(col, 9, 0x8b66) * 0.22) * (0.92 + facet * 0.12) * (0.9 + grain * 0.18);
    out.r = dark[0] * k; out.g = dark[1] * k; out.b = dark[2] * k;
    tintTowards(out, [0.42, 0.3, 0.22], rust * 0.25);
    tintTowards(out, [0.47, 0.49, 0.43], lichen * 0.3);
    tintTowards(out, [0.42, 0.41, 0.39], streak * 0.25);
    const shut = Math.max(gap, cross * 0.7);
    out.r *= 1 - shut * 0.45; out.g *= 1 - shut * 0.45; out.b *= 1 - shut * 0.45;
    out.h = facet * 0.45 - gap * 0.6 - cross * 0.35 + grain * 0.1 + 0.3;
    out.rough = 0.84;
  };
  const basaltTop = (x: number, y: number, out: { r: number; g: number; b: number; h: number; rough: number }): void => {
    const u = x / ROCK_SIZE, v = y / ROCK_SIZE;
    const c = cellular(u, v, 10, 0x8b77);
    const joint = 1 - smoothstep(0.03, 0.09, c.f2 - c.f1);
    const top = latticeHash(c.id, 4, 0x8b88);
    const rust = smoothstep(0.62, 0.78, fbm(b1, u * 7 + 4, v * 7 + 2, 7, 3));
    const lichen = smoothstep(0.66, 0.78, fbm(b1, u * 20 + 8, v * 20 + 1, 20, 2));
    const grain = fbm(b1, u * 128 + 5, v * 128 + 6, 128, 2);
    const k = (0.84 + top * 0.24) * (0.9 + grain * 0.18) * (0.94 + c.f1 * 0.1);
    out.r = dark[0] * k; out.g = dark[1] * k; out.b = dark[2] * k;
    tintTowards(out, [0.42, 0.3, 0.22], rust * 0.3);
    tintTowards(out, [0.48, 0.5, 0.44], lichen * 0.5);
    out.r *= 1 - joint * 0.6; out.g *= 1 - joint * 0.6; out.b *= 1 - joint * 0.6;
    out.h = 0.55 + top * 0.15 - c.f1 * 0.2 - joint * 0.55 + grain * 0.1;
    out.rough = 0.86;
  };
  const layer = (shade: SurfaceRecipe['shade'], relief: number): SurfaceRecipe => ({ size: ROCK_SIZE, worldSize: ROCK_WORLD, relief, shade });
  return [
    ['terrain-rock-granite', layer(graniteFace, 2.2)],
    ['terrain-rock-granite-top', layer(graniteTop, 2.2)],
    ['terrain-rock-sandstone', layer(sandstoneFace, 2.0)],
    ['terrain-rock-sandstone-top', layer(sandstoneTop, 2.0)],
    ['terrain-rock-basalt', layer(basaltFace, 2.6)],
    ['terrain-rock-basalt-top', layer(basaltTop, 2.4)],
  ];
})();

/** Tiling noise stretched along v: the mean of samples stacked up the column */
function streakNoise(noise: (x: number, y: number, period: number) => number, u: number, v: number, period: number): number {
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += fbm(noise, u * period, v * period + k * 0.75, period, 2);
  // Averaging flattens the contrast; stretched back about the middle.
  return Math.min(1, Math.max(0, 0.5 + (sum / 8 - 0.5) * 2.2));
}

/** The grass's tones, sRGB: deep clump green, sunlit green, dry straw, bare soil. */
// The dark tone close to the lit one
const GRASS_TONES = {
  dark: [0.27, 0.34, 0.19],
  lit: [0.33, 0.4, 0.21],
  dry: [0.41, 0.4, 0.28],
  soil: [0.36, 0.3, 0.2],
} as const;

/** The land's surfaces: the grass, the rock layers (in `ROCK_RECIPES` order: one texture array) and the dirt. */
export function terrainRecipes(): { readonly grass: SurfaceRecipe; readonly rocks: readonly SurfaceRecipe[]; readonly dirt: SurfaceRecipe } {
  const grassFine = makeNoise(0x1234);
  const grassClump = makeNoise(0x9f2c);
  const grass: SurfaceRecipe = {
    size: 1024,
    worldSize: m(38.4),
    // Read at map zoom, where a pixel is a metre or two: the detail that shows is TUFTS a few metres across
    relief: 0.9,
    shade: (x, y, out) => {
      const u = x / 1024;
      const v = y / 1024;
      // Domain-warped: value noise alone is laid on a square lattice and its blobs read as camouflage squares
      const wx = (fbm(grassClump, u * 24 + 11, v * 24, 24, 1) - 0.5) * 0.9;
      const wy = (fbm(grassClump, u * 24, v * 24 + 29, 24, 1) - 0.5) * 0.9;
      const speck = fbm(grassFine, u * 96 + wx * 2, v * 96 + wy * 2, 96, 2);
      const tuft = fbm(grassFine, u * 32 + wx + 3.1, v * 32 + wy + 7.7, 32, 2);
      const clump = fbm(grassClump, u * 10 + wx * 0.5, v * 10 + wy * 0.5, 10, 2);
      // sRGB: deep clump green, sunlit green, dry straw, bare soil (`GRASS_TONES`).
      const { dark, lit, dry, soil } = GRASS_TONES;
      const t = Math.min(1, Math.max(0, (tuft - 0.3) / 0.42));
      const k = t * t * (3 - 2 * t);
      let r = dark[0]! + (lit[0]! - dark[0]!) * k;
      let g = dark[1]! + (lit[1]! - dark[1]!) * k;
      let b = dark[2]! + (lit[2]! - dark[2]!) * k;
      // Dry patches over the higher, sunnier tufts of some clumps.
      const dryW = Math.min(1, Math.max(0, (clump - 0.6) / 0.12)) * k * 0.2;
      r += (dry[0]! - r) * dryW; g += (dry[1]! - g) * dryW; b += (dry[2]! - b) * dryW;
      // Soil showing in the gaps between tufts.
      const soilW = Math.min(1, Math.max(0, (speck - 0.7) / 0.08)) * (1 - k) * 0.45;
      r += (soil[0]! - r) * soilW; g += (soil[1]! - g) * soilW; b += (soil[2]! - b) * soilW;
      // GRAIN at the texel (9 cm): tufts of a couple of texels
      const tuftlet = fbm(grassFine, u * 384 + 1.7, v * 384 + 5.3, 384, 2);
      const blade = fbm(grassClump, u * 768 + 9.1, v * 768 + 2.9, 768, 1);
      const gap = blade < 0.3 ? 0.72 : 1;
      const tip = blade > 0.78 ? 1.16 : 1;
      const grain = (0.84 + tuftlet * 0.3) * gap * tip * (0.96 + speck * 0.08);
      // Sunlit tips lean yellow, shaded gaps blue-green.
      out.r = r * grain * (tip > 1 ? 1.05 : 1);
      out.g = g * grain;
      out.b = b * grain * (gap < 1 ? 1.08 : 1);
      out.h = k * 0.45 + tuftlet * 0.35 + (blade > 0.78 ? 0.2 : 0) - (gap < 1 ? 0.15 : 0) - soilW * 0.3;
      out.rough = 0.99;
    },
  };

  const rocks = ROCK_RECIPES.map(([, recipe]) => recipe);

  const dirtGrain = makeNoise(0x3311);
  const dirt: SurfaceRecipe = {
    size: 256,
    worldSize: m(13.6),
    relief: 2.4,
    shade: (x, y, out) => {
      const u = x / 256;
      const v = y / 256;
      const grain = fbm(dirtGrain, u * 90, v * 90, 90, 3);
      const patch = fbm(dirtGrain, u * 8 + 3, v * 8 + 9, 8, 3);
      // Gullies: narrow across, long up the face, so on a bank (read from the side) they run down the slope as rain cuts them.
      const gully = streakNoise(dirtGrain, u, v, 48);
      const cut = Math.max(0, 0.5 - gully) * 2;
      const tone = 0.34 + (grain - 0.5) * 0.08 + patch * 0.07 - cut * 0.09 + Math.max(0, gully - 0.6) * 0.12;
      // Red-brown, the colour of the tropics' weathered soils (latossolo).
      out.r = tone * 1.22;
      out.g = tone * 0.8;
      out.b = tone * 0.58;
      out.h = grain * 0.7 + patch * 0.3;
      out.rough = 0.97;
    },
  };

  return { grass, rocks, dirt };
}
