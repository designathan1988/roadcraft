import {
  CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Texture,
} from 'three';

/**
 * Procedural texture baking.
 *
 * Every surface in the game is textured from canvases painted here rather than
 * from image files. Three reasons, in order of weight:
 *
 *  1. **They tile seamlessly by construction.** The noise below is periodic, so
 *     a road can repeat its asphalt a thousand times with no visible seam — the
 *     failure a photographic tile always eventually shows.
 *  2. **The normal and roughness maps come from the same height field as the
 *     colour**, so the lighting agrees with what the surface looks like. That
 *     agreement is most of what makes a flat polygon read as a material.
 *  3. Nothing to download, so the first frame is never a grey placeholder.
 *
 * Every texture is cached by key: a rebuild of the road network must not bake a
 * new 512x512 canvas per band per structure, which is what made an edit stutter.
 */

const cache = new Map<string, Texture>();

/** Transferable pixels produced by the same canvas recipes in a worker. */
export interface BakedPixels {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayBuffer;
}

export function canvasPixels(key: string, texture: Texture): BakedPixels {
  const canvas = texture.image as HTMLCanvasElement | OffscreenCanvas;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  const image = context?.getImageData(0, 0, canvas.width, canvas.height);
  if (!image) throw new Error(`Cannot read baked texture ${key}`);
  return { key, width: canvas.width, height: canvas.height, rgba: image.data.buffer };
}

/** The worker sends raw texels, preserving the original canvas pixels exactly. */
export function bakedTextureFromPixels(pixels: BakedPixels, srgb: boolean): Texture {
  const value = new DataTexture(new Uint8Array(pixels.rgba), pixels.width, pixels.height, RGBAFormat, UnsignedByteType);
  value.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  value.wrapS = RepeatWrapping;
  value.wrapT = RepeatWrapping;
  value.magFilter = LinearFilter;
  value.minFilter = LinearMipmapLinearFilter;
  value.flipY = true;
  value.generateMipmaps = true;
  value.needsUpdate = true;
  return value;
}

export function takeBakedSurfacePixels(): BakedPixels[] {
  return [...cache].map(([key, value]) => canvasPixels(key, value));
}

export function primeBakedSurfacePixels(pixels: readonly BakedPixels[]): void {
  for (const item of pixels) cache.set(item.key, bakedTextureFromPixels(item, item.key.endsWith(':map')));
}

export function bakedTexture(key: string): Texture | undefined { return cache.get(key); }
export function rememberBakedTexture(key: string, value: Texture): void { cache.set(key, value); }

function setAnisotropy(value: Texture, anisotropy: number): void {
  if (value.anisotropy >= anisotropy) return;
  value.anisotropy = anisotropy;
  value.needsUpdate = true;
}

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

export interface SurfaceBake {
  readonly map: Texture;
  readonly normalMap: Texture;
  readonly roughnessMap: Texture;
}

function texture(canvas: HTMLCanvasElement, srgb: boolean, repeat: number, anisotropy: number): Texture {
  const value = new CanvasTexture(canvas);
  if (srgb) value.colorSpace = SRGBColorSpace;
  value.wrapS = RepeatWrapping;
  value.wrapT = RepeatWrapping;
  value.repeat.set(repeat, repeat);
  value.anisotropy = anisotropy;
  value.needsUpdate = true;
  return value;
}

function canvasOf(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * Derives a tangent-space normal map from a height field, by central difference.
 *
 * The strength is in texels, so the same number means the same visual relief
 * whatever the resolution.
 */
export function normalMapFrom(height: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(size);
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  normalTexels(height, size, strength, image.data);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** The RGBA texels of `normalMapFrom`, written into `out` (size * size * 4). */
export function normalTexels(height: Float32Array, size: number, strength: number, out: Uint8ClampedArray): void {
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
      // Recipe heights are bounded near 0..1, so direct length cannot overflow;
      // the general-purpose hypot scaling was repeated for every texel.
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const index = (y * size + x) * 4;
      // Every channel in [-1, 1] as [0, 1]: three decodes all three with
      // `* 2.0 - 1.0` (normal_fragment_maps; glTF 2.0 normalTexture). Z was
      // written as 1/length, so a tilted texel decoded flatter than meant,
      // and past length 2 turned inward - black specks on brick and stone.
      out[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      out[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      out[index + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      out[index + 3] = 255;
    }
  }
}

/**
 * Roughness in red and green and, when `metal` is given, metalness in blue:
 * three reads roughness from G and metalness from B of their maps
 * (roughnessmap_fragment, metalnessmap_fragment), the glTF 2.0
 * metallicRoughnessTexture layout, so one texture serves as both.
 */
export function grayscaleCanvas(values: Float32Array, size: number, metal?: Float32Array): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(size);
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, values[i] as number)) * 255);
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = metal ? Math.round(Math.min(1, Math.max(0, metal[i] as number)) * 255) : v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface SurfaceRecipe {
  readonly size: number;
  /** World units covered by one tile of the texture. */
  readonly worldSize: number;
  /**
   * Fills colour (0..1 rgb), height (0..1) and roughness (0..1) for one texel,
   * and metalness (0..1, reset to 0 for each texel) where `metallic` is set.
   * `u`/`v` are texel coordinates, so a recipe can draw lines as well as noise.
   */
  readonly shade: (
    u: number,
    v: number,
    out: { r: number; g: number; b: number; h: number; rough: number; metal?: number },
  ) => void;
  /** Relief strength of the derived normal map. */
  readonly relief: number;
  /**
   * A surface of metal and non-metal side by side (a curtain wall's aluminium
   * mullions round its glass): `out.metal` is baked into the blue channel of
   * the roughness map, to be set as the material's `metalnessMap` too.
   */
  readonly metallic?: boolean;
}

/**
 * Bakes one material's colour, normal and roughness maps in a single sweep.
 *
 * `repeat` is derived from the world size the recipe declares and the world
 * size of the surface it goes on, which is set where the material is used.
 */
export function bakeSurface(key: string, recipe: SurfaceRecipe, anisotropy: number): SurfaceBake {
  const cached = cache.get(`${key}:map`);
  if (cached) {
    const normalMap = cache.get(`${key}:normal`) as Texture;
    const roughnessMap = cache.get(`${key}:rough`) as Texture;
    setAnisotropy(cached, anisotropy);
    setAnisotropy(normalMap, anisotropy);
    setAnisotropy(roughnessMap, anisotropy);
    return {
      map: cached,
      normalMap,
      roughnessMap,
    };
  }

  const size = recipe.size;
  const { canvas, ctx } = canvasOf(size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = recipe.metallic ? new Float32Array(size * size) : undefined;
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.9, metal: 0 };

  if (ctx) {
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out.metal = 0;
        recipe.shade(x, y, out);
        const index = y * size + x;
        image.data[index * 4] = Math.round(Math.min(1, Math.max(0, out.r)) * 255);
        image.data[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, out.g)) * 255);
        image.data[index * 4 + 2] = Math.round(Math.min(1, Math.max(0, out.b)) * 255);
        image.data[index * 4 + 3] = 255;
        height[index] = out.h;
        rough[index] = out.rough;
        if (metal) metal[index] = out.metal;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  const map = texture(canvas, true, 1, anisotropy);
  const normalMap = texture(normalMapFrom(height, size, recipe.relief), false, 1, anisotropy);
  const roughnessMap = texture(grayscaleCanvas(rough, size, metal), false, 1, anisotropy);
  cache.set(`${key}:map`, map);
  cache.set(`${key}:normal`, normalMap);
  cache.set(`${key}:rough`, roughnessMap);
  return { map, normalMap, roughnessMap };
}

export function disposeBakedTextures(): void {
  for (const value of cache.values()) value.dispose();
  cache.clear();
}
