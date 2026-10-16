import {
  CompressedArrayTexture, CompressedTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat,
  SRGBColorSpace, UnsignedByteType, type CompressedPixelFormat, type WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { KHR_SUPERCOMPRESSION_ZSTD, read, type KTX2Container } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';
import { forgetOtherDerived } from './derivedCache';
import { primeSurfaceTextures, refillSurfaceTexels } from './surfaceTextures';

/** The procedural surfaces, baked at build time into KTX2 files (`scripts/vite/surface-bake-plugin.ts`) and read here once, while the town is built: nothing is baked during play */

interface ManifestEntry {
  readonly name: string;
  readonly file: string;
  readonly use: 'color' | 'normal' | 'data';
}

interface Manifest {
  readonly hash: string;
  readonly codec: 'rgba8' | 'uastc';
  readonly textures: readonly ManifestEntry[];
}

interface SurfaceBakeResult {
  readonly manifest: Manifest;
  readonly textures: ReadonlyMap<string, CompressedTexture>;
}

declare const __SURFACE_BAKE_HASH__: string | undefined;
/** The fingerprint of the recipes' code (`surface-bake-plugin.ts`): a new bake is a new URL, never an old file from the cache */
const BAKE_HASH = typeof __SURFACE_BAKE_HASH__ !== 'undefined' ? __SURFACE_BAKE_HASH__ : 'none';
const FOLDER = `${import.meta.env.BASE_URL}cooked/surfaces/`;
/** Basis Universal's transcoder from three's addons, served by the plugin at a fixed path (Vite's prebundled three cannot find it beside the loader). */
const TRANSCODER = `${import.meta.env.BASE_URL}basis/`;

/** Each level's texels of an uncompressed file (`rgba8`), Zstandard undone. */
async function rawLevels(container: KTX2Container, zstd: () => Promise<ZSTDDecoder>): Promise<Uint8Array[]> {
  if (container.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZSTD) return container.levels.map((level) => level.levelData);
  const decoder = await zstd();
  return container.levels.map((level) => decoder.decode(level.levelData, level.uncompressedByteLength));
}

/** An RGBA8 file as a texture of its own mip levels: three uploads an RGBA "compressed" texture level by level (WebGLTextures, `texSubImage2D`/`3D`), which a DataArrayTexture cannot. */
async function rgbaTexture(buffer: ArrayBuffer, zstd: () => Promise<ZSTDDecoder>): Promise<CompressedTexture> {
  const container = read(new Uint8Array(buffer));
  const levels = await rawLevels(container, zstd);
  const width = container.pixelWidth, height = container.pixelHeight;
  const mipmaps = levels.map((data, i) => ({ data, width: Math.max(1, width >> i), height: Math.max(1, height >> i) }));
  const format = RGBAFormat as unknown as CompressedPixelFormat;
  return container.layerCount > 1
    ? new CompressedArrayTexture(mipmaps, width, height, container.layerCount, format, UnsignedByteType)
    : new CompressedTexture(mipmaps, width, height, format, UnsignedByteType);
}

/** What the GPU can take a UASTC file as (BC7, ASTC, ETC2...), asked of a throwaway WebGL2 context: the game's renderer is made after the textures are read. */
function transcodeTargets(loader: KTX2Loader): KTX2Loader {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { powerPreference: 'high-performance' });
  const names = new Set(gl?.getSupportedExtensions() ?? []);
  // `detectSupport` reads only `extensions.has` and, for ASTC, `extensions.get(...).getSupportedProfiles()` (three r186)
  const extensions = { has: (name: string): boolean => names.has(name), get: (name: string): unknown => gl?.getExtension(name) ?? null };
  loader.detectSupport({ extensions } as unknown as WebGLRenderer);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return loader;
}

/** Reads the named files; UASTC through three's KTX2Loader, whose transcoding workers are let go once they are done. */
async function readFiles(manifest: Manifest, entries: readonly ManifestEntry[]): Promise<Map<string, CompressedTexture>> {
  const loader = manifest.codec === 'uastc' ? transcodeTargets(new KTX2Loader().setTranscoderPath(TRANSCODER)) : null;
  // One Zstandard decoder for the batch, made when the first file needs it
  let decoder: Promise<ZSTDDecoder> | null = null;
  const zstd = (): Promise<ZSTDDecoder> => (decoder ??= (async () => {
    const made = new ZSTDDecoder();
    await made.init();
    return made;
  })());
  try {
    const textures = await Promise.all(entries.map(async (entry) => {
      const response = await fetch(`${FOLDER}${entry.file}?v=${manifest.hash}`);
      if (!response.ok) throw new Error(`Baked surface ${entry.file}: HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const texture = loader
        ? await new Promise<CompressedTexture>((resolve, reject) => loader.parse(buffer, resolve, reject))
        : await rgbaTexture(buffer, zstd);
      // As the canvas bakes were: repeating, trilinear, sRGB colour and linear data
      texture.colorSpace = entry.use === 'color' ? SRGBColorSpace : NoColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = false;
      texture.name = entry.name;
      texture.needsUpdate = true;
      return [entry.name, texture] as const;
    }));
    return new Map(textures);
  } finally {
    loader?.dispose();
  }
}

/** Reads every baked surface while the main thread builds the town. */
export async function startSurfaceBake(): Promise<SurfaceBakeResult> {
  // The texels the old in-game bake kept in IndexedDB (some 70 MB a build) are no longer read: let go.
  forgetOtherDerived('surface', 'ktx2');
  const response = await fetch(`${FOLDER}manifest.json?v=${BAKE_HASH}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`No baked surfaces at ${FOLDER} (HTTP ${response.status}): the surface-bake plugin did not run`);
  const manifest = (await response.json()) as Manifest;
  if (manifest.hash !== BAKE_HASH && BAKE_HASH !== 'none') throw new Error(`The baked surfaces are ${manifest.hash}, this build's recipes ${BAKE_HASH}`);
  return { manifest, textures: await readFiles(manifest, manifest.textures) };
}

/** Install the textures before the first material is made; a texture whose texels were let go reads its file again when it must be uploaded anew. */
export function primeSurfaceBake(result: SurfaceBakeResult): void {
  primeSurfaceTextures(result.textures, (names) => {
    const entries = result.manifest.textures.filter((entry) => names.includes(entry.name));
    void readFiles(result.manifest, entries).then(refillSurfaceTexels, (error: unknown) => {
      console.error('Baked surfaces could not be read again', error);
    });
  });
}
