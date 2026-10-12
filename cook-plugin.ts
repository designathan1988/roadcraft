import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The people cooked ahead (`src/render/people/cookedPerson.ts`).
 *
 * `__PEOPLE_COOK_HASH__` is a fingerprint of everything a body is built from:
 * the code a cooked body is made by - the import closure of `ENTRY`, read in
 * full - and the people assets (their names and sizes).
 *
 * The closure, not whole folders: hashing all of `src/render/people` made an
 * edit to code no cooked body uses (the procedural crowd) stale every body,
 * and the game built each of them during play, 200-550 ms a body, unseen
 * (docs/performance.md #7); and it missed `riggedCitizens.ts`, `citizenBake.ts`
 * and `citizenWalk.ts`, which do build them. The cook (`scripts/cook-people.mjs`) stamps it on what it
 * writes; the game reads a cooked body only under the same fingerprint, and
 * builds it otherwise - a change to how people are built is never served a
 * stale body.
 *
 * Development: `/cooked/...` is served from `cooked/`, and the cook script
 * PUTs its files to `/__cook/...`. Build: `cooked/people` is copied into
 * `dist/cooked/people` when its stamp matches.
 */
/** Where a cooked body is built (`personAsset`, `__cookPeople`): its imports are what the hash reads. */
const ENTRY = 'src/render/riggedCitizens.ts';
/**
 * The cooks: each a folder of `cooked/`, stamped with the fingerprint of its
 * own code. `people`: the cast's bodies (`cookedPerson.ts`). `procedural`: the
 * procedural crowd's classes and hairstyles (`proceduralCook.ts`), made by
 * `proceduralBake.ts` alone - how the crowd is drawn (`proceduralCrowd.ts`)
 * changes nothing cooked, so it is not in the fingerprint.
 */
const COOKS = [
  { dir: 'people', entry: ENTRY, define: '__PEOPLE_COOK_HASH__' },
  { dir: 'procedural', entry: 'src/render/people/proceduralBake.ts', define: '__PROCEDURAL_COOK_HASH__' },
] as const;
type CookDir = typeof COOKS[number]['dir'];
/**
 * The derived data kept in the player's browser (`src/render/derivedCache.ts`):
 * each kind filed under the fingerprint of the code that makes it - the
 * import closure of its maker and the package files it reads - so a change to
 * that code never serves an old one. Nothing is cooked here: the game makes
 * each the first time and keeps it.
 */
const DERIVED = [
  { entry: 'src/render/buildings/parts.ts', also: [] as string[], define: '__BUILDING_KIT_HASH__' },
  { entry: 'src/render/surfaceBake.worker.ts', also: [] as string[], define: '__SURFACE_BAKE_HASH__' },
  // The procedural crowd's levels of each piece (`proceduralCrowd.ts` lodPlan).
  { entry: 'src/render/people/crowdLod.ts', also: [] as string[], define: '__CROWD_LOD_HASH__' },
  // The conflict zones of each pair of movements (`world/conflictPoints.ts`, kept by `main.ts`).
  { entry: 'src/world/conflictPoints.ts', also: [] as string[], define: '__CONFLICT_ZONES_HASH__' },
  // The road surfaces' tiles (`render/roadSurfaces.ts`, kept by `renderer.ts`).
  { entry: 'src/render/roadSurfaces.ts', also: [] as string[], define: '__ROAD_TILES_HASH__' },
] as const;
const ASSETS = ['public/models/people'];
/** The path aliases of `tsconfig.json`. */
const ALIASES: readonly [string, string][] = [
  ['@core/', 'src/core/'], ['@world/', 'src/world/'], ['@sim/', 'src/sim/'], ['@render/', 'src/render/'],
  ['@view/', 'src/view/'], ['@editor/', 'src/editor/'], ['@ui/', 'src/ui/'], ['@people/', 'src/people/'],
];

/**
 * Every source file `entry` runs, transitively: static imports and exports
 * (not `import type`), dynamic imports and `new URL(...)` workers and data.
 * Packages are left out (their versions are in the lockfile).
 */
export function importClosure(root: string, entry: string): string[] {
  const resolve = (from: string, spec: string): string | null => {
    const alias = ALIASES.find(([key]) => spec.startsWith(key));
    const base = alias ? path.join(root, alias[1], spec.slice(alias[0].length))
      : spec.startsWith('.') ? path.join(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    const text = fs.readFileSync(file, 'utf8');
    const refs = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(refs)) {
      const found = resolve(file, (m[1] ?? m[2] ?? m[3])!);
      if (found) visit(found);
    }
  };
  visit(path.join(root, entry));
  return [...seen].sort();
}
const DIR = 'cooked';

function walk(root: string, out: string[]): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) { out.push(root); return; }
  for (const name of fs.readdirSync(root).sort()) walk(path.join(root, name), out);
}

export function peopleCookHash(root: string, entry: string = ENTRY): string {
  const hash = createHash('sha256');
  for (const file of importClosure(root, entry)) {
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    // Line endings do not change a body.
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  const assets: string[] = [];
  for (const a of ASSETS) walk(path.join(root, a), assets);
  for (const file of assets) hash.update(`${path.relative(root, file).replace(/\\/g, '/')}:${fs.statSync(file).size}`);
  return hash.digest('hex').slice(0, 16);
}

/** The fingerprint of a derived kind (`DERIVED`): its maker's import closure and the files it also reads. */
export function derivedHash(root: string, entry: string, also: readonly string[] = []): string {
  const hash = createHash('sha256');
  for (const file of importClosure(root, entry)) {
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  for (const file of also) {
    const at = path.join(root, file);
    if (fs.existsSync(at)) hash.update(fs.readFileSync(at, 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Refuses to build a game whose people are not the ones this code makes.
 *
 * The bodies are read back only under the fingerprint of the code that builds
 * them, and a body that does not match is built during play instead - 21 to
 * 92 ms a person, which is the stutter the player feels and nobody is told
 * about. `cooked/` is not committed (it is regenerated), so an edit to any
 * people source without a fresh cook is the ordinary way to get here.
 *
 * Both cases keep the game running - the runtime fallback is real and stays -
 * but neither is allowed through a release build in silence: this throws, the
 * build stops, and the message says what to run.
 */
function checkCooked(root: string, hash: string, dir: CookDir = 'people'): void {
  const manifest = path.join(root, DIR, dir, 'manifest.json');
  const fix = "Run `npm run cook:people` (a development server must be up: npx vite --port 4196 --strictPort --host 127.0.0.1) and build again.";
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `No cooked people in ${DIR}/${dir}: this build would build every person during play (21-92 ms each). ${fix}`,
    );
  }
  const stamp = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { hash?: string }).hash;
  if (stamp !== hash) {
    throw new Error(
      `The cooked people in ${DIR}/${dir} are stale: cooked under ${stamp ?? '(no hash)'}, this code fingerprints ${hash}. `
      + `The people sources or assets changed without a fresh cook. ${fix}`,
    );
  }
}

export function cookPlugin(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  const hashes = new Map<CookDir, string>();
  const fingerprints = (): Map<CookDir, string> => new Map(COOKS.map((c) => [c.dir, peopleCookHash(root, c.entry)]));
  const derived = (): Map<string, string> => new Map(DERIVED.map((d) => [d.define, derivedHash(root, d.entry, d.also)]));
  let derivedHashes = new Map<string, string>();
  const stampOf = (dir: CookDir): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(root, DIR, dir, 'manifest.json'), 'utf8')) as { hash?: string }).hash;
    } catch {
      return undefined;
    }
  };
  let building = false;
  let checked = false;
  return {
    name: 'roadcraft-cook',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      for (const [dir, value] of fingerprints()) hashes.set(dir, value);
      derivedHashes = derived();
      return {
        define: {
          ...Object.fromEntries(COOKS.map((c) => [c.define, JSON.stringify(hashes.get(c.dir))])),
          ...Object.fromEntries([...derivedHashes].map(([name, value]) => [name, JSON.stringify(value)])),
        },
      };
    },
    // A release build refuses stale people; a dev server must still start,
    // because cooking them needs one running. There the console says it
    // instead (`cookedPerson.ts`), and the game builds each body meanwhile.
    buildStart() {
      if (!building || checked) return;
      checked = true;
      for (const c of COOKS) checkCooked(root, hashes.get(c.dir)!, c.dir);
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
      building = resolved.command === 'build';
    },
    configureServer(server) {
      // A change to how people are built changes the fingerprint: the server
      // restarts with the new one, and the cooked bodies no longer match.
      // So does a change to how a derived kind is made: kept under the old
      // fingerprint, an old one would be read back.
      const watched = [
        ...COOKS.flatMap((c) => importClosure(root, c.entry)), ...ASSETS.map((s) => path.join(root, s)),
        ...DERIVED.flatMap((d) => importClosure(root, d.entry)),
      ];
      server.watcher.on('change', (file) => {
        if (!watched.some((w) => path.resolve(file).startsWith(path.resolve(w)))) return;
        const now = fingerprints();
        const nowDerived = derived();
        if (COOKS.some((c) => now.get(c.dir) !== hashes.get(c.dir))
          || [...nowDerived].some(([name, value]) => derivedHashes.get(name) !== value)) void server.restart();
      });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (req.method === 'PUT' && url.startsWith('/__cook/')) {
          const target = path.join(root, DIR, path.normalize(url.slice('/__cook/'.length)).replace(/^(\.\.[/\\])+/, ''));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => { fs.writeFileSync(target, Buffer.concat(chunks)); res.statusCode = 204; res.end(); });
          return;
        }
        if (req.method === 'GET' && url.startsWith('/cooked/')) {
          const file = path.join(root, DIR, path.normalize(url.slice('/cooked/'.length)).replace(/^(\.\.[/\\])+/, ''));
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(file).pipe(res);
            return;
          }
          res.statusCode = 404; res.end(); return;
        }
        next();
      });
    },
    closeBundle() {
      for (const c of COOKS) {
        if (stampOf(c.dir) !== hashes.get(c.dir)) continue;
        const from = path.join(root, DIR, c.dir);
        const to = path.join(outDir, DIR, c.dir);
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
      }
    },
  };
}
