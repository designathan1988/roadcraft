import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RepeatWrapping, RGBAFormat } from 'three';
import { fogAt, type FogDab, type FogSample } from '@world/fogPaint';
import { m } from '@world/units';
import { TorusWindow, type TexelBand } from './torusWindow';

/** The painted fog as the post pass reads it (`postprocess.ts` CLOUD_SHADOWS): a window of the land round the view, wrapping round (`torusWindow.ts`) */

/** Texels across the window: 20 m a texel over its 10,240 m (the old map's, so the same fog where it was). */
const FOG_RES = 512;
const FOG_CELL = m(20);
/** How far the view goes from the window's middle before it follows (texels): the texels that came in written, no others. */
const FOG_HOLD = FOG_RES / 8;

export interface FogLayer {
  readonly texture: DataTexture;
  /** Lowest ground under any fog and the highest its top reaches, world units (the slab the rays march). */
  readonly low: number;
  readonly high: number;
  /** Any fog at all. */
  readonly any: boolean;
  /** The window's low corner (world x, y) and its side: the shader reads world / side, the texture repeating, nothing off it. */
  readonly window: readonly [number, number, number];
}

export function createFogTexture(): DataTexture {
  const texture = new DataTexture(new Uint16Array(FOG_RES * FOG_RES * 4), FOG_RES, FOG_RES, RGBAFormat, HalfFloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** A world rectangle: [minX, minY, maxX, maxY]. */
type Rect = readonly [number, number, number, number];

/** DO NOT raster the whole window at every dab: 262 144 texels and a ground height each, for a brush's few metres. */
export interface FogField {
  /** Every texel, from these dabs and this ground (the first time, or when the diary cannot say where). */
  whole(dabs: readonly FogDab[], groundAt: (x: number, y: number) => number): FogLayer;
  /** Only the texels inside `rects`. */
  update(dabs: readonly FogDab[], groundAt: (x: number, y: number) => number, rects: readonly Rect[]): FogLayer;
  /** The window kept round where the view looks (world x, y): only the texels that came in written; null when it stayed. */
  follow(x: number, y: number, dabs: readonly FogDab[], groundAt: (x: number, y: number) => number): FogLayer | null;
}

export function createFogField(texture: DataTexture): FogField {
  const data = texture.image.data as Uint16Array;
  const view = new TorusWindow(FOG_RES, FOG_CELL);
  const cell = FOG_CELL;
  const zero = DataUtils.toHalfFloat(0);
  const sample: FogSample = { density: 0, height: 0, speed: 0 };
  /** Each texture row's lowest ground under fog and highest fog top (Infinity / -Infinity: none in the row). */
  const rowLow = new Float64Array(FOG_RES).fill(Infinity);
  const rowHigh = new Float64Array(FOG_RES).fill(-Infinity);
  /** Whether the texture has reached the GPU whole: until then a range would send only that range. */
  let uploaded = false;
  texture.onUpdate = () => { uploaded = true; };

  /** World texels [gx0, gx1] x [gy0, gy1] of the window worked out from `dabs` (those that can reach them); their rows marked to send. */
  const raster = (dabs: readonly FogDab[], groundAt: (x: number, y: number) => number, [gx0, gx1, gy0, gy1]: TexelBand): void => {
    const x0 = (gx0 + 0.5) * cell, x1 = (gx1 + 0.5) * cell;
    const reach = dabs.filter((d) => d.x + d.radius > x0 && d.x - d.radius < x1);
    const width = gx1 - gx0 + 1, first = view.texel(gx0);
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = (gy + 0.5) * cell;
      const j = view.texel(gy);
      const row = reach.filter((d) => Math.abs(d.y - y) < d.radius);
      let low = Infinity, high = -Infinity;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = (gx + 0.5) * cell;
        const k = (j * FOG_RES + view.texel(gx)) * 4;
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
      if (width < FOG_RES) {
        // Part of the row: its slab from every other texel of it with fog (read back from the texture).
        for (let i = 0; i < FOG_RES; i++) {
          if ((i - first + FOG_RES) % FOG_RES < width) continue;
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
      if (uploaded) texture.addUpdateRange(j * FOG_RES * 4, FOG_RES * 4);
    }
    texture.needsUpdate = true;
  };
  const layer = (): FogLayer => {
    let low = Infinity, high = -Infinity;
    for (let j = 0; j < FOG_RES; j++) { low = Math.min(low, rowLow[j]!); high = Math.max(high, rowHigh[j]!); }
    const any = Number.isFinite(low);
    return { texture, low: any ? low : 0, high: any ? high : 0, any, window: [view.ox * cell, view.oy * cell, view.span] };
  };
  return {
    whole(dabs, groundAt) {
      raster(dabs, groundAt, view.whole);
      texture.clearUpdateRanges();
      texture.needsUpdate = true;
      return layer();
    },
    update(dabs, groundAt, rects) {
      for (const r of rects) {
        const band = view.bandOf(r);
        if (band) raster(dabs, groundAt, band);
      }
      return layer();
    },
    follow(x, y, dabs, groundAt) {
      const bands = view.follow(x, y, FOG_HOLD);
      if (!bands) return null;
      for (const band of bands) raster(dabs, groundAt, band);
      return layer();
    },
  };
}
