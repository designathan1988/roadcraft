import type { EcologyField } from '@world/ecology';
import { landNormalsInto } from './plateMesh';
import type { TexelBox } from './stagedTexels';

/** A TERRAIN PLATE'S TEXELS WORKED OUT FROM THEIR TRUTH at each send (`terrain.ts`, `stagedTexels.ts`): the heights, the corner store, the ecology, the light */

/** A value 0..1 as the byte the textures carry. */
const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);

/** The land's texels (`terrainLod.ts`) of a box of corners (null: all), from the heights and diagonals: per corner its normal's x and z, its cell's diagonal and its height, as `buildPlateMesh` makes them. */
export function landTexelsInto(heights: ArrayLike<number>, flip: ArrayLike<number>, side: number, half: number, cell: number,
  into: Float32Array, box: TexelBox | null): void {
  const seg = side - 1;
  const x0 = Math.max(0, box?.x0 ?? 0), x1 = Math.min(seg, box?.x1 ?? seg);
  const y0 = Math.max(0, box?.y0 ?? 0), y1 = Math.min(seg, box?.y1 ?? seg);
  if (x1 < x0 || y1 < y0) return;
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const v = ix + iy * side;
      // A corner of the last row or column has no cell of its own.
      into[v * 4 + 2] = ix < seg && iy < seg ? flip[ix + iy * seg] as number : 0;
      into[v * 4 + 3] = heights[v] as number;
    }
  }
  landNormalsInto(heights, flip, side, half, cell, into, x0, x1, y0, y1);
}

/** A plate's corner store: the water's level (`NO_WATER` far from it) and the painted sandstone and basalt, per corner. */
export interface CornerStore {
  readonly levels: Float32Array;
  readonly sand: Float32Array;
  readonly basalt: Float32Array;
}

/** The covers painted at a corner, 0..1 (`terrain.ts` coverAt). */
export type CornerCover = (corner: number, kind: 'flowers' | 'scrub' | 'forest') => number;

/** The ground corners' covers (`terrain.ts` ShoreTextures, RGBA 16 bits; the water's level is a texture of its own): R the flowers low and the sandstone high, G the scrub low and the basalt high, B the forest's byte. */
/** `side` corners a side; `box` (null: all) the corners a send takes: DO NOT work out the whole plate's 103 thousand corners for a stroke's few rows (TER-08), as `landTexelsInto` keeps to its box. */
export function groundCornersInto(into: Uint16Array, store: CornerStore, cover: CornerCover, side: number, box: TexelBox | null = null): void {
  const { sand, basalt } = store;
  const seg = side - 1;
  const x0 = Math.max(0, box?.x0 ?? 0), x1 = Math.min(seg, box?.x1 ?? seg);
  const y0 = Math.max(0, box?.y0 ?? 0), y1 = Math.min(seg, box?.y1 ?? seg);
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const k = ix + iy * side;
      into[k * 4] = byte(cover(k, 'flowers')) + 256 * byte(sand[k] as number);
      into[k * 4 + 1] = byte(cover(k, 'scrub')) + 256 * byte(basalt[k] as number);
      into[k * 4 + 2] = byte(cover(k, 'forest'));
      into[k * 4 + 3] = 0;
    }
  }
}

/** The ecology's layer (the shore array's second) from `offset`: canopy, dry grass, wet ground and bare ground per corner, bytes over 255; none without an ecosystem. */
export function ecologyCornersInto(into: Float32Array, offset: number, count: number, field: EcologyField | null): void {
  if (!field) { into.fill(0, offset, offset + count * 4); return; }
  for (let i = 0; i < count; i++) {
    const canopy = field.canopy[i] as number, trees = field.trees[i] as number, grass = field.grass[i] as number;
    const o = offset + i * 4;
    into[o] = byte(canopy + trees * 0.3 + (field.palm[i] as number) * 0.25) / 255;
    into[o + 1] = byte(grass * (field.dry[i] as number)) / 255;
    into[o + 2] = byte(field.wet[i] as number) / 255;
    into[o + 3] = byte((1 - grass) * (1 - Math.min(1, canopy + trees))) / 255;
  }
}

/** The land's light (`side` corners a side, RGBA a corner) into a paint layer `res` texels a side: rows at its stride, nothing past them. */
export function lightLayerInto(layer: Uint8Array, res: number, light: Uint8Array, side: number): void {
  layer.fill(0);
  for (let y = 0; y < side; y++) layer.set(light.subarray(y * side * 4, (y + 1) * side * 4), y * res * 4);
}

/** The light as the worker sends it (a rect of corners, rows of its width) into the light store and, when given, a paint layer at its stride. */
export function lightRectInto(light: Uint8Array, side: number, rect: TexelBox, rgba: Uint8Array, layer: Uint8Array | null, res: number): void {
  const width = rect.x1 - rect.x0 + 1;
  for (let iy = rect.y0; iy <= rect.y1; iy++) {
    const row = rgba.subarray((iy - rect.y0) * width * 4, (iy - rect.y0 + 1) * width * 4);
    light.set(row, (iy * side + rect.x0) * 4);
    layer?.set(row, (iy * res + rect.x0) * 4);
  }
}
