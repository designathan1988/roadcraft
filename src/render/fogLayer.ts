import { ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat } from 'three';
import { MAP_HALF, MAP_SIZE } from '@world/bounds';
import { fogAt, type FogDab, type FogSample } from '@world/fogPaint';

/**
 * The painted fog as the post pass reads it (`postprocess.ts` CLOUD_SHADOWS):
 * a map over the land: R the fog's density there (0..1, the dabs rasterised
 * by `fogAt`), G the height of the ground under it, so the bank lies on the
 * land and follows it into the valleys, B how high that fog stands and A how
 * fast it drifts (each painted with the brush's own settings). Half floats,
 * filtered.
 * Kept by the rectangles that changed (`createFogField`).
 */

/** Texels across the map: some 20 m a texel. */
export const FOG_RES = 512;

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

/** A world rectangle: [minX, minY, maxX, maxY]. */
type Rect = readonly [number, number, number, number];

/**
 * The fog map kept up to date by the rectangles that changed: a dab painted
 * or wiped, the land or the ground under it moved. Only the texels of those
 * rectangles are worked out again and only their rows go to the GPU (three
 * sends an update range as one row of the image); the slab (`low`, `high`)
 * is kept a row at a time. DO NOT raster the whole map at every dab: 262 144
 * texels and a ground height each, for a brush's few metres.
 */
export interface FogField {
  /** Every texel, from these dabs and this ground (the first time, or when the diary cannot say where). */
  whole(dabs: readonly FogDab[], groundAt: (x: number, y: number) => number): FogLayer;
  /** Only the texels inside `rects`. */
  update(dabs: readonly FogDab[], groundAt: (x: number, y: number) => number, rects: readonly Rect[]): FogLayer;
}

export function createFogField(texture: DataTexture): FogField {
  const data = texture.image.data as Uint16Array;
  const half = MAP_HALF;
  const cell = MAP_SIZE / FOG_RES;
  const zero = DataUtils.toHalfFloat(0);
  const sample: FogSample = { density: 0, height: 0, speed: 0 };
  /** Each row's lowest ground under fog and highest fog top (Infinity / -Infinity: none in the row). */
  const rowLow = new Float64Array(FOG_RES).fill(Infinity);
  const rowHigh = new Float64Array(FOG_RES).fill(-Infinity);
  /** Whether the texture has reached the GPU whole: until then a range would send only that range. */
  let uploaded = false;
  texture.onUpdate = () => { uploaded = true; };

  /** Texels [i0, i1] x [j0, j1] worked out from `dabs` (those that can reach them). */
  const raster = (dabs: readonly FogDab[], groundAt: (x: number, y: number) => number, i0: number, i1: number, j0: number, j1: number): void => {
    const x0 = -half + (i0 + 0.5) * cell, x1 = -half + (i1 + 0.5) * cell;
    const reach = dabs.filter((d) => d.x + d.radius > x0 && d.x - d.radius < x1);
    for (let j = j0; j <= j1; j++) {
      const y = -half + (j + 0.5) * cell;
      const row = reach.filter((d) => Math.abs(d.y - y) < d.radius);
      let low = Infinity, high = -Infinity;
      // The row's slab outside the span stays as it was: taken from the row's own texels below.
      for (let i = i0; i <= i1; i++) {
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
          low = Math.min(low, ground);
          // Thin to under a twentieth three heights up.
          high = Math.max(high, ground + sample.height * 3);
        }
      }
      if (i0 > 0 || i1 < FOG_RES - 1) {
        // Part of the row: its slab from every texel of it with fog (read back from the texture).
        for (let i = 0; i < FOG_RES; i++) {
          if (i >= i0 && i <= i1) continue;
          const k = (j * FOG_RES + i) * 4;
          const density = DataUtils.fromHalfFloat(data[k]!);
          if (density <= 0.002) continue;
          const ground = DataUtils.fromHalfFloat(data[k + 1]!);
          low = Math.min(low, ground);
          high = Math.max(high, ground + DataUtils.fromHalfFloat(data[k + 2]!) * 3);
        }
      }
      rowLow[j] = low;
      rowHigh[j] = high;
    }
  };
  const layer = (): FogLayer => {
    let low = Infinity, high = -Infinity;
    for (let j = 0; j < FOG_RES; j++) { low = Math.min(low, rowLow[j]!); high = Math.max(high, rowHigh[j]!); }
    const any = Number.isFinite(low);
    return { texture, low: any ? low : 0, high: any ? high : 0, any };
  };
  return {
    whole(dabs, groundAt) {
      raster(dabs, groundAt, 0, FOG_RES - 1, 0, FOG_RES - 1);
      texture.clearUpdateRanges();
      texture.needsUpdate = true;
      return layer();
    },
    update(dabs, groundAt, rects) {
      let any = false;
      for (const r of rects) {
        const i0 = Math.max(0, Math.floor((r[0] + half) / cell)), i1 = Math.min(FOG_RES - 1, Math.floor((r[2] + half) / cell));
        const j0 = Math.max(0, Math.floor((r[1] + half) / cell)), j1 = Math.min(FOG_RES - 1, Math.floor((r[3] + half) / cell));
        if (i0 > i1 || j0 > j1) continue;
        raster(dabs, groundAt, i0, i1, j0, j1);
        if (uploaded) for (let j = j0; j <= j1; j++) texture.addUpdateRange(j * FOG_RES * 4, FOG_RES * 4);
        any = true;
      }
      if (any) texture.needsUpdate = true;
      return layer();
    },
  };
}
