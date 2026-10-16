import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KHR_SUPERCOMPRESSION_ZSTD, read, VK_FORMAT_R8G8B8A8_SRGB, VK_FORMAT_R8G8B8A8_UNORM } from 'three/examples/jsm/libs/ktx-parse.module.js';

import { alphaCoverage, flipRows, mipChain, rgbaKtx2 } from '../../scripts/vite/ktx2';

/** A square of RGBA texels from a function of the texel. */
function texels(size: number, at: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.set(at(x, y), (y * size + x) * 4);
  return out;
}

/** A level's bytes as written, Zstandard undone. */
function levelBytes(file: Uint8Array, level: number): Uint8Array {
  const container = read(file);
  const data = container.levels[level]!.levelData;
  if (container.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZSTD) return data;
  const decompress = (zlib as unknown as { zstdDecompressSync?: (data: Uint8Array) => Buffer }).zstdDecompressSync!;
  return new Uint8Array(decompress(data));
}

describe('the baked surfaces\' KTX2 files', () => {
  it('turns the rows over, as three uploaded the canvas (flipY)', () => {
    const top = texels(4, (x, y) => [x, y, 0, 255]);
    const flipped = flipRows(top, 4);
    expect([...flipped.subarray(0, 4)]).toEqual([0, 3, 0, 255]);
    expect([...flipRows(flipped, 4)]).toEqual([...top]);
  });

  it('makes every level down to one texel, data averaged as stored and colour in linear light', () => {
    const checker = texels(8, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const data = mipChain(checker, 8, 'data');
    expect(data.map((level) => level.length / 4)).toEqual([64, 16, 4, 1]);
    // Half of 255, rounded
    expect([...data[1]!.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
    // Black and white mixed as light: sRGB 188, not 128
    const colour = mipChain(checker, 8, 'color');
    expect([...colour[3]!]).toEqual([188, 188, 188, 255]);
  });

  it('keeps the alpha-tested coverage of mip 0 in every level when asked (foliage)', () => {
    // Scattered leaves: about 30 % of the texels opaque, the rest clear, by a fixed hash
    const leaf = (x: number, y: number): boolean => {
      let h = Math.imul(x, 374_761_393) ^ Math.imul(y, 668_265_263);
      h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
      return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296 < 0.3;
    };
    const leaves = texels(64, (x, y) => [90, 140, 60, leaf(x, y) ? 255 : 0]);
    const ref = 0.5;
    const plain = mipChain(leaves, 64, 'color');
    const kept = mipChain(leaves, 64, 'color', ref);
    const coverage0 = alphaCoverage(leaves, ref);
    expect(coverage0).toBeGreaterThan(0.2);
    expect(coverage0).toBeLessThan(0.4);
    // A plain box filter thins them to nothing three levels down: 64 texels averaged to about 30 % alpha, under the test at 50 %
    expect(alphaCoverage(plain[3]!, ref)).toBeLessThan(0.05);
    // Kept as covered while a level has texels enough to say so (8 x 8 and up)
    for (const level of kept.slice(1, 4)) expect(Math.abs(alphaCoverage(level, ref) - coverage0)).toBeLessThan(0.15);
    // Mip 0 untouched
    expect([...kept[0]!]).toEqual([...leaves]);
  });

  it('writes an sRGB or linear RGBA8 file whose mip 0 is the texels given, layer after layer', () => {
    const a = texels(4, (x, y) => [x * 60, y * 60, 7, 255]);
    const b = texels(4, (x, y) => [y * 60, x * 60, 9, 255]);
    const levels = [0, 1, 2].map((level) => [mipChain(a, 4, 'normal')[level]!, mipChain(b, 4, 'normal')[level]!]);
    const file = rgbaKtx2(levels, 4, 'normal');
    const container = read(file);
    expect(container.vkFormat).toBe(VK_FORMAT_R8G8B8A8_UNORM);
    expect(container.layerCount).toBe(2);
    expect(container.levels.length).toBe(3);
    expect([...levelBytes(file, 0)]).toEqual([...a, ...b]);
    const colour = read(rgbaKtx2([[a], [mipChain(a, 4, 'color')[1]!], [mipChain(a, 4, 'color')[2]!]], 4, 'color'));
    expect(colour.vkFormat).toBe(VK_FORMAT_R8G8B8A8_SRGB);
    expect(colour.layerCount).toBe(0);
  });
});
