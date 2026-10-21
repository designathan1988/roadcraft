/** Two renderers' pictures of one view, compared pixel by pixel (`MIGRACAO-WEBGPU.md`: a migrated material replaces the old one only when this passes).
 *  Both pictures come in linear, as half floats (each renderer drew into a target of its own, no tone mapping), and go out through the SAME
 *  film curve and sRGB here: what differs is what the materials drew, never the output transform. */

/** One half float (IEEE 754 binary16) as a number. */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/** three's ACES filmic curve (r186 `tonemapping_pars_fragment` ACESFilmicToneMapping), exposure 1: the game's own (`renderer.ts`). */
function aces(r: number, g: number, b: number, out: Float64Array): void {
  r /= 0.6; g /= 0.6; b /= 0.6;
  const x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const y = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const z = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const fx = fit(x), fy = fit(y), fz = fit(z);
  out[0] = Math.min(1, Math.max(0, 1.60475 * fx - 0.53108 * fy - 0.07367 * fz));
  out[1] = Math.min(1, Math.max(0, -0.10208 * fx + 1.10813 * fy - 0.00605 * fz));
  out[2] = Math.min(1, Math.max(0, -0.00327 * fx - 0.07276 * fy + 1.07602 * fz));
}

/** sRGB's transfer (three's `sRGBTransferOETF`), 0..1 to 0..255. */
const srgb = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** 0.41666 - 0.055));

/** A linear half-float RGBA picture as the player sees it: the film curve, sRGB, 8 bits. `flipY` for a picture read bottom row first (WebGL `readPixels`). */
export function toDisplay(half: Uint16Array, width: number, height: number, flipY: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const mapped = new Float64Array(3);
  for (let y = 0; y < height; y++) {
    const from = (flipY ? height - 1 - y : y) * width * 4;
    const to = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      aces(halfToFloat(half[from + x]!), halfToFloat(half[from + x + 1]!), halfToFloat(half[from + x + 2]!), mapped);
      out[to + x] = srgb(mapped[0]!);
      out[to + x + 1] = srgb(mapped[1]!);
      out[to + x + 2] = srgb(mapped[2]!);
      out[to + x + 3] = 255;
    }
  }
  return out;
}

export interface PictureDifference {
  /** The mean, over every pixel, of its largest channel difference, in 8-bit steps (0..255). */
  mean: number;
  /** The share of pixels, %, whose largest channel difference is over `threshold`. */
  over: number;
  /** The threshold, 8-bit steps. */
  threshold: number;
  /** The largest difference anywhere, 8-bit steps. */
  max: number;
  /** The difference as a picture: black where equal, brighter red the larger it is (x4), white where over the threshold's 8 times. */
  image: Uint8ClampedArray;
}

/** Two display pictures of the same size compared pixel by pixel: each pixel's largest channel difference. */
export function comparePictures(a: Uint8ClampedArray, b: Uint8ClampedArray, threshold = 8): PictureDifference {
  if (a.length !== b.length) throw new Error(`pictures of different sizes (${a.length} and ${b.length} bytes)`);
  const image = new Uint8ClampedArray(a.length);
  const pixels = a.length / 4;
  let sum = 0, over = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
    sum += d;
    if (d > threshold) over++;
    if (d > max) max = d;
    const white = d > threshold * 8 ? 255 : 0;
    image[i] = Math.max(white, d * 4);
    image[i + 1] = white;
    image[i + 2] = white;
    image[i + 3] = 255;
  }
  return { mean: pixels ? sum / pixels : 0, over: pixels ? (100 * over) / pixels : 0, threshold, max, image };
}
