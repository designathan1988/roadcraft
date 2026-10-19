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
/** Texels a block of a row: each block's slab from its half floats kept, read back only when texels of it were written (TER-14). */
const FOG_BLOCK = 64;
const FOG_BLOCKS = FOG_RES / FOG_BLOCK;

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
  /** Each block of each row's lowest ground under fog and highest fog top as its half floats read back (`FOG_BLOCK`), and whether texels of it were written since. */
  const blockLow = new Float64Array(FOG_RES * FOG_BLOCKS).fill(Infinity);
  const blockHigh = new Float64Array(FOG_RES * FOG_BLOCKS).fill(-Infinity);
  const blockStale = new Uint8Array(FOG_RES * FOG_BLOCKS).fill(1);
  /** The slab of texels [i0, i1) of row j read back from the half floats, into `slab`. */
  const slab = { low: Infinity, high: -Infinity };
  const readBack = (j: number, i0: number, i1: number): void => {
    for (let i = i0; i < i1; i++) {
      const k = (j * FOG_RES + i) * 4;
      const density = DataUtils.fromHalfFloat(data[k]!);
      if (density <= 0.002) continue;
      const ground = DataUtils.fromHalfFloat(data[k + 1]!);
      slab.low = Math.min(slab.low, ground);
      slab.high = Math.max(slab.high, ground + DataUtils.fromHalfFloat(data[k + 2]!) * 3);
    }
  };
  /** Whether the texture has reached the GPU whole: until then a range would send only that range. */
  let uploaded = false;
  /** The whole texture asked to be sent: no range added until it is (a range would cut the send to it). */
  let sendWhole = true;
  /** The dabs a band or a row can reach, one array each for every raster (DO NOT `filter` a new one a texel). */
  const reach: FogDab[] = [];
  const row: FogDab[] = [];
  const near: FogDab[] = [];
  /** DO NOT raster a window with no fog in it (a ground height a texel, 262 144 of them, and the strips the view brings in): nothing reads it until a dab is laid, and then the whole window is rastered. */
  let blank = false;
  /** No fog anywhere: the window left as it is, every row empty. */
  const clear = (): FogLayer => {
    blank = true;
    rowLow.fill(Infinity);
    rowHigh.fill(-Infinity);
    return layer();
  };
  texture.onUpdate = () => { uploaded = true; sendWhole = false; };

  /** World texels [gx0, gx1] x [gy0, gy1] of the window worked out from `dabs` (those that can reach them); their rows marked to send. */
  const raster = (dabs: readonly FogDab[], groundAt: (x: number, y: number) => number, [gx0, gx1, gy0, gy1]: TexelBand): void => {
    const x0 = (gx0 + 0.5) * cell, x1 = (gx1 + 0.5) * cell;
    reach.length = 0;
    for (const d of dabs) if (d.x + d.radius > x0 && d.x - d.radius < x1) reach.push(d);
    const width = gx1 - gx0 + 1, first = view.texel(gx0);
    // A band over more than a quarter of the rows (the view moved along x: a strip of every row) sent whole, in one call, never a call a row (TER-14).
    if (!sendWhole && uploaded && gy1 - gy0 + 1 > FOG_RES / 4) {
      sendWhole = true;
      texture.clearUpdateRanges();
    }
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = (gy + 0.5) * cell;
      const j = view.texel(gy);
      row.length = 0;
      for (const d of reach) if (Math.abs(d.y - y) < d.radius) row.push(d);
      let low = Infinity, high = -Infinity;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = (gx + 0.5) * cell;
        const k = (j * FOG_RES + view.texel(gx)) * 4;
        near.length = 0;
        for (const d of row) if (Math.abs(d.x - x) < d.radius) near.push(d);
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
      // Part of the row: its slab from every other texel of it with fog, read back from the texture: a block none of whose texels were
      // written from its slab kept, a block written in part from its texels outside the band (TER-14: never the whole row decoded).
      for (let b = 0; b < FOG_BLOCKS; b++) {
        const i0 = b * FOG_BLOCK, at = j * FOG_BLOCKS + b;
        let inside = 0;
        for (let i = i0; i < i0 + FOG_BLOCK; i++) if ((i - first + FOG_RES) % FOG_RES < width) inside++;
        // Written: read back again when next read.
        if (inside > 0) blockStale[at] = 1;
        if (width < FOG_RES) {
          if (inside === FOG_BLOCK) continue;
          if (inside === 0) {
            if (blockStale[at]) {
              slab.low = Infinity; slab.high = -Infinity;
              readBack(j, i0, i0 + FOG_BLOCK);
              blockLow[at] = slab.low; blockHigh[at] = slab.high; blockStale[at] = 0;
            }
            low = Math.min(low, blockLow[at]!);
            high = Math.max(high, blockHigh[at]!);
            continue;
          }
          slab.low = low; slab.high = high;
          for (let i = i0; i < i0 + FOG_BLOCK; i++) if ((i - first + FOG_RES) % FOG_RES >= width) readBack(j, i, i + 1);
          low = slab.low; high = slab.high;
        }
      }
      rowLow[j] = low;
      rowHigh[j] = high;
      // Only the band's columns of the row, in two where it wraps round the texture.
      if (uploaded && !sendWhole) {
        const run = Math.min(width, FOG_RES - first);
        texture.addUpdateRange((j * FOG_RES + first) * 4, run * 4);
        if (run < width) texture.addUpdateRange(j * FOG_RES * 4, (width - run) * 4);
      }
    }
    texture.needsUpdate = true;
  };
  const layer = (): FogLayer => {
    let low = Infinity, high = -Infinity;
    for (let j = 0; j < FOG_RES; j++) { low = Math.min(low, rowLow[j]!); high = Math.max(high, rowHigh[j]!); }
    const any = Number.isFinite(low);
    return { texture, low: any ? low : 0, high: any ? high : 0, any, window: [view.ox * cell, view.oy * cell, view.span] };
  };
  const whole = (dabs: readonly FogDab[], groundAt: (x: number, y: number) => number): FogLayer => {
    if (dabs.length === 0) return clear();
    blank = false;
    raster(dabs, groundAt, view.whole);
    sendWhole = true;
    texture.clearUpdateRanges();
    texture.needsUpdate = true;
    return layer();
  };
  return {
    whole,
    update(dabs, groundAt, rects) {
      if (dabs.length === 0) return clear();
      // The first fog on a window left unrastered: all of it, as the first time.
      if (blank) return whole(dabs, groundAt);
      for (const r of rects) {
        const band = view.bandOf(r);
        if (band) raster(dabs, groundAt, band);
      }
      return layer();
    },
    follow(x, y, dabs, groundAt) {
      const bands = view.follow(x, y, FOG_HOLD);
      if (blank && dabs.length > 0) return whole(dabs, groundAt);
      if (!bands) return null;
      if (dabs.length === 0) return clear();
      for (const band of bands) raster(dabs, groundAt, band);
      return layer();
    },
  };
}
