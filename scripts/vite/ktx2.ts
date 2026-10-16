import zlib from 'node:zlib';
import {
  KHR_DF_CHANNEL_RGBSDA_ALPHA, KHR_DF_CHANNEL_RGBSDA_BLUE, KHR_DF_CHANNEL_RGBSDA_GREEN, KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_MODEL_RGBSDA, KHR_DF_PRIMARIES_BT709, KHR_DF_SAMPLE_DATATYPE_LINEAR, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB,
  KHR_SUPERCOMPRESSION_NONE, KHR_SUPERCOMPRESSION_ZSTD, VK_FORMAT_R8G8B8A8_SRGB, VK_FORMAT_R8G8B8A8_UNORM,
  createDefaultContainer, read, write, type KTX2Container, type KTX2Level, type KTX2Sample,
} from 'three/examples/jsm/libs/ktx-parse.module.js';

/** KTX 2.0 files of the baked surfaces (Khronos, KTX File Format Specification 2.0): mipmaps made here, RGBA8 or UASTC, Zstandard per level */

/** How a texture's texels are read: sRGB colour (mipmaps averaged in linear light), a normal map or plain data (averaged as stored, as the GPU's `generateMipmap` did). */
export type TextureUse = 'color' | 'normal' | 'data';
/** RGBA8 keeps every texel of mip 0 exactly; UASTC (Basis Universal, transcoded to BC7 or ASTC on the GPU) is a quarter of the memory but lossy. */
export type TextureCodec = 'rgba8' | 'uastc';

/** The rows upside down: a canvas holds its top row first, a KTX2 level its texture row `t = 0` first (three uploaded the canvas with `flipY`). */
export function flipRows(texels: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(texels.length);
  const row = size * 4;
  for (let y = 0; y < size; y++) out.set(texels.subarray((size - 1 - y) * row, (size - y) * row), y * row);
  return out;
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** A linear value in 0..1 as an sRGB byte (IEC 61966-2-1). */
function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** One level down by a 2 x 2 box: colour in linear light, everything else as stored. */
function halve(level: Uint8Array, size: number, use: TextureUse): Uint8Array {
  const half = size >> 1;
  const out = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const a = ((2 * y) * size + 2 * x) * 4;
      const b = a + 4;
      const c = a + size * 4;
      const d = c + 4;
      const o = (y * half + x) * 4;
      for (let k = 0; k < 4; k++) {
        if (use === 'color' && k < 3) {
          const sum = SRGB_TO_LINEAR[level[a + k] as number]! + SRGB_TO_LINEAR[level[b + k] as number]!
            + SRGB_TO_LINEAR[level[c + k] as number]! + SRGB_TO_LINEAR[level[d + k] as number]!;
          out[o + k] = linearToSrgb(sum / 4);
        } else {
          out[o + k] = ((level[a + k] as number) + (level[b + k] as number) + (level[c + k] as number) + (level[d + k] as number) + 2) >> 2;
        }
      }
    }
  }
  return out;
}

/** An alpha byte times `scale`, as it is stored. */
const scaledAlpha = (alpha: number, scale: number): number => Math.min(255, Math.round(alpha * scale));

/** The share of a level's texels whose alpha, times `scale` and stored as a byte, passes the alpha test at `ref` (0..1). */
export function alphaCoverage(level: Uint8Array, ref: number, scale = 1): number {
  let passed = 0;
  for (let i = 3; i < level.length; i += 4) if (scaledAlpha(level[i] as number, scale) / 255 > ref) passed++;
  return passed / (level.length / 4);
}

/** A level's alpha scaled so the share of texels passing the test at `ref` is as near `target` as its bytes allow (I. Castaño, "Computing Alpha Mipmaps", 2010; here the scale is bisected on the stored bytes, so rounding cannot drop a texel under the test). */
function scaleAlphaToCoverage(level: Uint8Array, target: number, ref: number): Uint8Array {
  // Coverage only grows with the scale: `low` stays under the target, `high` reaches it (256 makes every alpha but 0 opaque)
  let low = 0;
  let high = 256;
  if (alphaCoverage(level, ref, high) >= target) {
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (alphaCoverage(level, ref, mid) >= target) high = mid;
      else low = mid;
    }
  }
  // The nearer of the two; a tie keeps the leaves
  const scale = target - alphaCoverage(level, ref, low) < alphaCoverage(level, ref, high) - target ? low : high;
  const out = level.slice();
  for (let i = 3; i < out.length; i += 4) out[i] = scaledAlpha(out[i] as number, scale);
  return out;
}

/** Every level from `level0` (power-of-two square) down to 1 x 1; with `alphaRef`, each level keeps mip 0's alpha-test coverage (foliage that stays as full far away). */
export function mipChain(level0: Uint8Array, size: number, use: TextureUse, alphaRef?: number): Uint8Array[] {
  if (size < 1 || (size & (size - 1)) !== 0) throw new Error(`A baked texture must be a power-of-two square, not ${size}`);
  const filtered = [level0];
  for (let s = size; s > 1; s >>= 1) filtered.push(halve(filtered[filtered.length - 1]!, s, use));
  if (alphaRef === undefined) return filtered;
  const target = alphaCoverage(level0, alphaRef);
  // Each level made from its parent as filtered, never from a scaled one, then scaled on its own
  return filtered.map((level, i) => (i === 0 ? level : scaleAlphaToCoverage(level, target, alphaRef)));
}

/** Zstandard of one level (Node 22.15+ has it in `zlib`), or null without it. */
function zstd(data: Uint8Array): Uint8Array | null {
  const compress = (zlib as unknown as { zstdCompressSync?: (data: Uint8Array, options: { params: Record<number, number> }) => Buffer }).zstdCompressSync;
  const level = (zlib.constants as unknown as Record<string, number | undefined>)['ZSTD_c_compressionLevel'];
  if (!compress || level === undefined) return null;
  // Level 10 of 1..19: a middle between file size and the time of a developer's first start (not measured)
  const out = compress(data, { params: { [level]: 10 } });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Each level's layers in one run (KTX2: layer, then face, then slice), Zstandard-compressed when Node can; the levels largest first. */
function packLevels(levels: readonly (readonly Uint8Array[])[]): { levels: KTX2Level[]; scheme: number } {
  const runs = levels.map((layers) => {
    const run = new Uint8Array(layers.reduce((sum, layer) => sum + layer.length, 0));
    let at = 0;
    for (const layer of layers) { run.set(layer, at); at += layer.length; }
    return run;
  });
  const packed = runs.map(zstd);
  if (packed.every((p) => p !== null)) {
    return { levels: packed.map((p, i) => ({ levelData: p!, uncompressedByteLength: runs[i]!.length })), scheme: KHR_SUPERCOMPRESSION_ZSTD };
  }
  return { levels: runs.map((run) => ({ levelData: run, uncompressedByteLength: run.length })), scheme: KHR_SUPERCOMPRESSION_NONE };
}

/** The container's shape: a square, an array when it has more than one layer. */
function shaped(container: KTX2Container, size: number, layers: number, levelCount: number): void {
  container.pixelWidth = size;
  container.pixelHeight = size;
  container.pixelDepth = 0;
  container.layerCount = layers > 1 ? layers : 0;
  container.faceCount = 1;
  container.levelCount = levelCount;
  // Rows bottom first (`flipRows`): x to the right, y up.
  container.keyValue = { KTXorientation: 'ru' };
}

const sample = (bitOffset: number, channelType: number): KTX2Sample => ({
  bitOffset, bitLength: 7, channelType, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255,
});

/** An uncompressed R8G8B8A8 file: `levels[level][layer]`, rows bottom first. */
export function rgbaKtx2(levels: readonly (readonly Uint8Array[])[], size: number, use: TextureUse): Uint8Array {
  const srgb = use === 'color';
  const container = createDefaultContainer();
  shaped(container, size, levels[0]!.length, levels.length);
  container.vkFormat = srgb ? VK_FORMAT_R8G8B8A8_SRGB : VK_FORMAT_R8G8B8A8_UNORM;
  container.typeSize = 1;
  const packed = packLevels(levels);
  container.supercompressionScheme = packed.scheme;
  container.levels = packed.levels;
  container.dataFormatDescriptor = [{
    vendorId: 0, descriptorType: 0, versionNumber: 2,
    colorModel: KHR_DF_MODEL_RGBSDA,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
    flags: 0,
    texelBlockDimension: [0, 0, 0, 0],
    bytesPlane: [4, 0, 0, 0, 0, 0, 0, 0],
    samples: [
      sample(0, KHR_DF_CHANNEL_RGBSDA_RED),
      sample(8, KHR_DF_CHANNEL_RGBSDA_GREEN),
      sample(16, KHR_DF_CHANNEL_RGBSDA_BLUE),
      // An sRGB file's alpha is linear (KTX 2.0, "Data Format Descriptor")
      sample(24, KHR_DF_CHANNEL_RGBSDA_ALPHA | (srgb ? KHR_DF_SAMPLE_DATATYPE_LINEAR : 0)),
    ],
  }];
  return write(container);
}

/** The part of `ktx2-encoder` (Basis Universal's encoder in WebAssembly) the bake calls. */
interface Ktx2Encoder {
  encodeToKTX2(image: Uint8Array, options: {
    isUASTC: boolean; generateMipmap: boolean; needSupercompression: boolean; uastcLDRQualityLevel: number; enableRDO: boolean;
    isPerceptual: boolean; isSetKTX2SRGBTransferFunc: boolean; isNormalMap: boolean; isYFlip: boolean;
    imageDecoder: (buffer: Uint8Array) => Promise<{ width: number; height: number; data: Uint8Array }>;
  }): Promise<Uint8Array>;
}

/** A UASTC file: each level and layer encoded on its own by Basis Universal (these mipmaps, not its own), the blocks put together and Zstandard per level. */
export async function uastcKtx2(levels: readonly (readonly Uint8Array[])[], size: number, use: TextureUse): Promise<Uint8Array> {
  // Not a dependency until UASTC is the codec (the player's yes on shots): installed then, resolved only at that call.
  const name = 'ktx2-encoder';
  const encoder = (await import(/* @vite-ignore */ name)) as unknown as Ktx2Encoder;
  const blocks: Uint8Array[][] = [];
  let first: KTX2Container | null = null;
  for (let level = 0; level < levels.length; level++) {
    const side = Math.max(1, size >> level);
    const layers: Uint8Array[] = [];
    for (const texels of levels[level]!) {
      const encoded = read(await encoder.encodeToKTX2(texels, {
        isUASTC: true,
        generateMipmap: false,
        needSupercompression: false,
        // Level 2 of 0..3: the slower, closer search; no rate-distortion pass (it trades quality for a smaller file)
        uastcLDRQualityLevel: 2,
        enableRDO: false,
        isPerceptual: use === 'color',
        isSetKTX2SRGBTransferFunc: use === 'color',
        isNormalMap: use === 'normal',
        isYFlip: false,
        imageDecoder: async () => ({ width: side, height: side, data: texels }),
      }));
      first ??= encoded;
      layers.push(encoded.levels[0]!.levelData.slice());
    }
    blocks.push(layers);
  }
  const container = createDefaultContainer();
  shaped(container, size, levels[0]!.length, levels.length);
  // The encoder's own format and descriptor (UASTC: `VK_FORMAT_UNDEFINED`, colour model 166); the descriptor keeps its sizes when supercompressed
  container.vkFormat = first!.vkFormat;
  container.typeSize = first!.typeSize;
  container.dataFormatDescriptor = first!.dataFormatDescriptor;
  const packed = packLevels(blocks);
  container.supercompressionScheme = packed.scheme;
  container.levels = packed.levels;
  return write(container);
}
