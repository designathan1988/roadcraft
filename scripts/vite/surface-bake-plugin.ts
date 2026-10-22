import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runnerImport, type Plugin } from 'vite';
import { importClosure } from './cook-plugin.ts';
import { flipRows, mipChain, rgbaKtx2, uastcKtx2, type TextureCodec, type TextureUse } from './ktx2.ts';

/** The procedural surfaces baked at build time: the game's own recipes (`src/render/bake/catalogue.ts`) run in Node, written as KTX2 files with their mipmaps, cached by a fingerprint of the recipes' code */

const CATALOGUE = 'src/render/bake/catalogue.ts';
/** Where the files are written and served from (`/cooked/surfaces/`, `surfaceBakeClient.ts`). */
const OUT = path.join('cooked', 'surfaces');
/** Basis Universal's transcoder as three ships it, served at `/basis/` for `KTX2Loader.setTranscoderPath`. */
const BASIS = path.join('node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const;
/**
 * The codec: `uastc` (Basis Universal, transcoded by three's KTX2Loader to the GPU's own block format, BC7 on a desktop: a quarter of RGBA8's memory, kept
 * compressed on the GPU); `rgba8` (`ROADCRAFT_TEXTURE_CODEC=rgba8`) keeps every texel of mip 0 as the canvas bakes made it. DO NOT go back to RGBA8 by
 * default: the surfaces held 124 MB of the GPU (the facades' arrays 3 × 17 MB), 31 MB as BC7 (2026-10-22).
 */
const CODEC: TextureCodec = process.env['ROADCRAFT_TEXTURE_CODEC'] === 'rgba8' ? 'rgba8' : 'uastc';
/** The path aliases of `tsconfig.json`, for the recipes run in Node. */
const ALIASES = ['core', 'world', 'sim', 'render', 'view', 'editor', 'ui', 'people'] as const;

interface BakedTexture {
  readonly name: string;
  readonly use: TextureUse;
  readonly size: number;
  readonly layers: readonly Uint8Array[];
  readonly alphaRef?: number;
}

interface ManifestEntry {
  readonly name: string;
  readonly file: string;
  readonly use: TextureUse;
}

/** The fingerprint of the bake: the recipes' import closure, this plugin and its encoder, and the codec. */
function bakeHash(root: string): string {
  const hash = createHash('sha256');
  const files = [...importClosure(root, CATALOGUE), path.join(root, 'scripts', 'vite', 'ktx2.ts'), path.join(root, 'scripts', 'vite', 'surface-bake-plugin.ts')];
  for (const file of files) {
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  hash.update(CODEC);
  return hash.digest('hex').slice(0, 16);
}

/** The manifest's fingerprint, when every file it names is there. */
function bakedHash(dir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { hash?: string; textures?: ManifestEntry[] };
    if (!manifest.hash || !manifest.textures?.every((entry) => fs.existsSync(path.join(dir, entry.file)))) return null;
    return manifest.hash;
  } catch {
    return null;
  }
}

/** Runs every recipe and writes its KTX2 file, into a folder of its own first: a half-done bake is never served. */
async function bake(root: string, hash: string, log: (message: string) => void): Promise<void> {
  const out = path.join(root, OUT);
  if (bakedHash(out) === hash) return;
  const started = Date.now();
  const staging = `${out}.${hash}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const alias: Record<string, string> = { '@': path.join(root, 'src') };
  for (const name of ALIASES) alias[`@${name}`] = path.join(root, 'src', name);
  const { module } = await runnerImport<{ bakeCatalogue(): Iterable<BakedTexture> }>(path.join(root, CATALOGUE), {
    root, logLevel: 'warn', resolve: { alias },
  });
  const textures: ManifestEntry[] = [];
  let bytes = 0;
  for (const texture of module.bakeCatalogue()) {
    // levels[level][layer], rows bottom first as the canvas bakes were uploaded (`flipY`)
    const chains = texture.layers.map((layer) => mipChain(flipRows(layer, texture.size), texture.size, texture.use, texture.alphaRef));
    const levels = chains[0]!.map((_, level) => chains.map((chain) => chain[level]!));
    const file = `${texture.name.replace(/:/g, '.')}.ktx2`;
    const data = CODEC === 'uastc' ? await uastcKtx2(levels, texture.size, texture.use) : rgbaKtx2(levels, texture.size, texture.use);
    fs.writeFileSync(path.join(staging, file), data);
    bytes += data.byteLength;
    textures.push({ name: texture.name, file, use: texture.use });
  }
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ hash, codec: CODEC, textures }, null, 1));
  // The recipes changed while this bake ran: a newer one replaces it
  if (bakeHash(root) !== hash) { fs.rmSync(staging, { recursive: true, force: true }); return; }
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(staging, out);
  log(`surfaces baked (${CODEC}): ${textures.length} textures, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

export function surfaceBakePlugin(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  let hash = '';
  let building = false;
  /** The build is a server-side bundle (the desktop's job host): nothing to copy beside it. */
  let serverSide = false;
  const copyInto = (from: string, to: string, names: readonly string[]): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(from, name), path.join(to, name));
  };
  return {
    name: 'roadcraft-surface-bake',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      hash = bakeHash(root);
      return { define: { __SURFACE_BAKE_HASH__: JSON.stringify(hash) } };
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
      building = resolved.command === 'build';
      // DO NOT copy the surfaces into a server-side build (`desktop-jobs.config.ts`): the job host reads none of them (AST-04).
      serverSide = Boolean(resolved.build.ssr);
    },
    async buildStart() {
      if (building) await bake(root, hash, (message) => this.info(message));
    },
    configureServer(server) {
      const baking = bake(root, hash, (message) => server.config.logger.info(message));
      baking.catch((error: unknown) => server.config.logger.error(`surface bake failed: ${String(error)}`));
      // A change to a recipe changes the fingerprint: the server restarts, defines the new one and bakes it
      const watched = importClosure(root, CATALOGUE).map((file) => path.resolve(file));
      server.watcher.on('change', (file) => {
        if (!watched.includes(path.resolve(file))) return;
        if (bakeHash(root) !== hash) void server.restart();
      });
      // Registered before `cook-plugin.ts`, whose middleware then serves the files: no request for a surface before they are baked
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (url.startsWith('/cooked/surfaces/')) {
          baking.then(() => next(), (error: unknown) => { res.statusCode = 500; res.end(String(error)); });
          return;
        }
        const basis = BASIS_FILES.find((name) => url === `/basis/${name}`);
        if (basis) {
          res.setHeader('Content-Type', basis.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          fs.createReadStream(path.join(root, BASIS, basis)).pipe(res);
          return;
        }
        next();
      });
    },
    closeBundle() {
      if (!building || serverSide) return;
      const from = path.join(root, OUT);
      copyInto(from, path.join(outDir, OUT), fs.readdirSync(from));
      if (CODEC === 'uastc') copyInto(path.join(root, BASIS), path.join(outDir, 'basis'), BASIS_FILES);
    },
  };
}
