import { ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat } from 'three';
import { WORLD_HALF } from '@world/bounds';
import { fogAt, type FogDab, type FogSample } from '@world/fogPaint';

/**
 * The painted fog as the post pass reads it (`postprocess.ts` CLOUD_SHADOWS):
 * a map over the land: R the fog's density there (0..1, the dabs rasterised
 * by `fogAt`), G the height of the ground under it, so the bank lies on the
 * land and follows it into the valleys, B how high that fog stands and A how
 * fast it drifts (each painted with the brush's own settings). Half floats,
 * filtered.
 * Rebuilt when the fog or the land changes.
 */

/** Texels across the map: some 19 units a texel. */
export const FOG_RES = 256;

export interface FogLayer {
  readonly texture: DataTexture;
  /** Lowest ground under any fog and the highest its top reaches, world units (the slab the rays march). */
  readonly low: number;
  readonly high: number;
  /** Any fog at all. */
  readonly any: boolean;
}

export function createFogTexture(): DataTexture {
  const texture = new DataTexture(new Uint16Array(FOG_RES * FOG_RES * 4), FOG_RES, FOG_RES, RGBAFormat, HalfFloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Rasterises the fog dabs into `texture`: density, and the ground height under it. */
export function rasterFog(texture: DataTexture, dabs: readonly FogDab[], groundAt: (x: number, y: number) => number): FogLayer {
  const data = texture.image.data as Uint16Array;
  const half = WORLD_HALF;
  const cell = (WORLD_HALF * 2) / FOG_RES;
  // Only the texels a dab can reach are worked out: dabs culled per row.
  let low = Infinity, high = -Infinity, any = false;
  const zero = DataUtils.toHalfFloat(0);
  const sample: FogSample = { density: 0, height: 0, speed: 0 };
  for (let j = 0; j < FOG_RES; j++) {
    const y = -half + (j + 0.5) * cell;
    const row = dabs.filter((d) => Math.abs(d.y - y) < d.radius);
    for (let i = 0; i < FOG_RES; i++) {
      const x = -half + (i + 0.5) * cell;
      const k = (j * FOG_RES + i) * 4;
      const near = row.length ? row.filter((d) => Math.abs(d.x - x) < d.radius) : row;
      if (near.length) fogAt(near, x, y, sample); else sample.density = 0;
      const density = sample.density;
      // The ground everywhere a little fog may spread to by filtering.
      const ground = groundAt(x, y);
      data[k] = density > 0.002 ? DataUtils.toHalfFloat(density) : zero;
      data[k + 1] = DataUtils.toHalfFloat(ground);
      data[k + 2] = density > 0.002 ? DataUtils.toHalfFloat(sample.height) : zero;
      data[k + 3] = density > 0.002 ? DataUtils.toHalfFloat(sample.speed) : zero;
      if (density > 0.002) {
        any = true;
        low = Math.min(low, ground);
        // Thin to under a twentieth three heights up.
        high = Math.max(high, ground + sample.height * 3);
      }
    }
  }
  texture.needsUpdate = true;
  return { texture, low: any ? low : 0, high: any ? high : 0, any };
}
