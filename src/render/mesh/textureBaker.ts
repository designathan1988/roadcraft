/** Procedural texture recipes and the texels they bake: pure, run at build time (`scripts/vite/surface-bake-plugin.ts`), nothing baked during play. */

/** Deterministic 2D value noise with a positive integer period, so the result tiles. */
export function makeNoise(seed: number): (x: number, y: number, period: number) => number {
  const seedHash = Math.imul(seed, 2_246_822_519);
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ seedHash;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number, period: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const rx = x0 % period;
    const ry = y0 % period;
    const ax = rx < 0 ? rx + period : rx;
    const ay = ry < 0 ? ry + period : ry;
    const bx = ax + 1 === period ? 0 : ax + 1;
    const by = ay + 1 === period ? 0 : ay + 1;
    const a = hash(ax, ay);
    const b = hash(bx, ay);
    const c = hash(ax, by);
    const d = hash(bx, by);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Sums octaves of tiling value noise. Returns roughly 0..1. */
export function fbm(
  noise: (x: number, y: number, period: number) => number,
  x: number,
  y: number,
  basePeriod: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let period = basePeriod;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x * frequency, y * frequency, period);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
    period *= 2;
  }
  return sum / total;
}

/** The RGBA texels of a tangent-space normal map derived from a height field by central difference, written into `out` (size * size * 4). */
export function normalTexels(height: Float32Array, size: number, strength: number, out: Uint8Array | Uint8ClampedArray): void {
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const above = (y === 0 ? size - 1 : y - 1) * size;
    const below = (y + 1 === size ? 0 : y + 1) * size;
    let left = size - 1;
    for (let x = 0; x < size; x++) {
      const right = x + 1 === size ? 0 : x + 1;
      const dx = ((height[row + right] as number) - (height[row + left] as number)) * strength;
      const dy = ((height[below + x] as number) - (height[above + x] as number)) * strength;
      left = x;
      // Recipe heights are bounded near 0..1, so direct length cannot overflow
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const index = (y * size + x) * 4;
      // Every channel in [-1, 1] as [0, 1]: three decodes all three with `* 2.0 - 1.0`
      out[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      out[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      out[index + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      out[index + 3] = 255;
    }
  }
}

/** A value in 0..1 as a texel byte. */
const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);

export interface SurfaceRecipe {
  readonly size: number;
  /** World units covered by one tile of the texture. */
  readonly worldSize: number;
  /** Fills colour (0..1 rgb), height (0..1) and roughness (0..1) for one texel, and metalness */
  readonly shade: (
    u: number,
    v: number,
    out: { r: number; g: number; b: number; h: number; rough: number; metal?: number },
  ) => void;
  /** Relief strength of the derived normal map. */
  readonly relief: number;
  /** A surface of metal and non-metal side by side (a curtain wall's aluminium mullions round its glass) */
  readonly metallic?: boolean;
}

/** One recipe's colour, normal and roughness texels (RGBA, rows top first as a canvas holds them). */
interface SurfaceTexels {
  readonly size: number;
  readonly map: Uint8Array;
  readonly normal: Uint8Array;
  /** Roughness in red and green and, for a `metallic` recipe, metalness in blue */
  readonly rough: Uint8Array;
}

/** Bakes one recipe's colour, normal and roughness texels in a single sweep. */
export function surfaceTexels(recipe: SurfaceRecipe): SurfaceTexels {
  const size = recipe.size;
  const n = size * size;
  const map = new Uint8Array(n * 4);
  // Float32, as the canvas bake kept them: the same bytes come out
  const height = new Float32Array(n);
  const rough = new Float32Array(n);
  const metal = recipe.metallic ? new Float32Array(n) : undefined;
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.9, metal: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.metal = 0;
      recipe.shade(x, y, out);
      const index = y * size + x;
      map[index * 4] = byte(out.r);
      map[index * 4 + 1] = byte(out.g);
      map[index * 4 + 2] = byte(out.b);
      map[index * 4 + 3] = 255;
      height[index] = out.h;
      rough[index] = out.rough;
      if (metal) metal[index] = out.metal;
    }
  }
  const normal = new Uint8Array(n * 4);
  normalTexels(height, size, recipe.relief, normal);
  const roughTexels = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = byte(rough[i] as number);
    roughTexels[i * 4] = v;
    roughTexels[i * 4 + 1] = v;
    roughTexels[i * 4 + 2] = metal ? byte(metal[i] as number) : v;
    roughTexels[i * 4 + 3] = 255;
  }
  return { size, map, normal, rough: roughTexels };
}
