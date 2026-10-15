import { Color, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace } from 'three';

/** HOW BRIGHT EACH KIND OF LIGHT IS AFTER DARK, in one place. */
const BLOOM_THRESHOLD = 0.92;

/** I in candela as luminance on the scale above. */
const fromCandela = (cd: number): number => BLOOM_THRESHOLD + 0.7 * Math.log10(cd / 3);

export const NIGHT_LUMINANCE = {
  /** A lit room seen through its glass, on average: brighter than a lit wall, but UNDER the bloom's threshold */
  window: 0.72,
  /** The lantern beside a front door. */
  porchLamp: 2.4,
  headlamp: 3.0,
  /** 12 cd, within R1's 4-17. */
  tailLamp: fromCandela(12),
  /** 120 cd, within S1's 60-260: ten times a tail lamp. */
  brakeLamp: fromCandela(120),
  /** 150 cd, within R6's 50-200. */
  indicator: fromCandela(150),
  /** A bus's lit destination blind. */
  destination: 1.4,
} as const;

const scratch = new Color();

/** The luminance of an sRGB hex colour, in the working (linear) space. */
export function luminanceOf(hex: number): number {
  scratch.setHex(hex);
  return 0.2126 * scratch.r + 0.7152 * scratch.g + 0.0722 * scratch.b;
}

/** The factor a colour is multiplied by after dark to reach `target` luminance, over the 1 it is drawn with by day */
export function nightGain(hex: number, target: number): number {
  return Math.max(0, target / Math.max(1e-4, luminanceOf(hex)) - 1);
}

/** A soft round falloff, white in the middle, for a pool or a splash of lamplight laid additively on the ground or a wall */
export function lightPoolTexture(): DataTexture {
  const size = 64;
  const stops: readonly (readonly [number, number])[] = [[0, 1], [0.35, 0.55], [0.7, 0.15], [1, 0]];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      let alpha = 0;
      for (let k = 1; k < stops.length; k++) {
        const [r0, a0] = stops[k - 1]!, [r1, a1] = stops[k]!;
        if (r <= r1) { alpha = a0 + (a1 - a0) * Math.max(0, (r - r0) / (r1 - r0)); break; }
      }
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
