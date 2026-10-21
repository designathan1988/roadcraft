import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** The people cooked ahead (`src/render/people/cookedPerson.ts`, `proceduralCook.ts`): THE CAST IS FIXED */
const CAST = { people: '9e68cf27f80ce3b5', procedural: '72f9109bf47f92b7' } as const;
/** The cooks: each a folder of `cooked/`, stamped with its version of the cast. */
const COOKS = [
  { dir: 'people', stamp: CAST.people, define: '__PEOPLE_COOK_HASH__' },
  { dir: 'procedural', stamp: CAST.procedural, define: '__PROCEDURAL_COOK_HASH__' },
] as const;
type CookDir = typeof COOKS[number]['dir'];
/** The derived data kept in the player's browser (`src/core/derivedCache.ts`) */
const DERIVED = [
  { entry: 'src/render/buildings/parts.ts', also: [] as string[], define: '__BUILDING_KIT_HASH__' },
  // The procedural crowd's levels of each piece (`proceduralCrowd.ts` lodPlan).
  { entry: 'src/render/people/crowdLod.ts', also: [] as string[], define: '__CROWD_LOD_HASH__' },
  // The conflict zones of each pair of movements (`world/conflictPoints.ts`, kept by `main.ts`).
  { entry: 'src/world/conflictPoints.ts', also: [] as string[], define: '__CONFLICT_ZONES_HASH__' },
  // The road surfaces' tiles (`render/roadSurfaces.ts`, kept by `renderer.ts`).
  { entry: 'src/render/roadSurfaces.ts', also: [] as string[], define: '__ROAD_TILES_HASH__' },
  // The buildings' far levels baked per tile (`render/buildings/farTiles.ts`, kept by `farLevels.ts`).
  { entry: 'src/render/buildings/farTiles.ts', also: [] as string[], define: '__FAR_MASS_HASH__' },
  // The roads' far levels baked per tile (`render/farRoadTiles.ts`, kept by `farRoads.ts`).
  { entry: 'src/render/farRoadTiles.ts', also: [] as string[], define: '__FAR_ROADS_HASH__' },
  // The near products baked per tile (`render/nearBakers.ts`, kept by `nearTiles.ts`): poles, furniture, signs, barriers, trees, structures, gardens.
  { entry: 'src/render/nearBakers.ts', also: [] as string[], define: '__NEAR_TILES_HASH__' },
  // A plate's ecosystem and a far plate's woods (`world/ecology.ts`, `render/farWoods.ts`, kept by `ecologyKept.ts`).
  { entry: 'src/world/ecology.ts', also: [] as string[], define: '__ECOLOGY_HASH__' },
  { entry: 'src/render/farWoods.ts', also: [] as string[], define: '__FAR_WOODS_HASH__' },
  // A generated city of a seed, prepared (`cityGen.worker.ts`, kept by `main.ts` cityData).
  { entry: 'src/cityGen.worker.ts', also: [] as string[], define: '__CITY_GEN_HASH__' },
] as const;
/** The path aliases of `tsconfig.json`. */
const ALIASES: readonly [string, string][] = [
  ['@core/', 'src/core/'], ['@world/', 'src/world/'], ['@sim/', 'src/sim/'], ['@render/', 'src/render/'],
  ['@view/', 'src/view/'], ['@editor/', 'src/editor/'], ['@ui/', 'src/ui/'], ['@people/', 'src/people/'],
  // `tsconfig.json` and `vite.config.ts` also map `@/` to `src/`: a file reached only through it is code the bake runs too.
  ['@/', 'src/'],
];

/** Every source file `entry` runs, transitively: static imports and exports */
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
    // A file deleted while the server runs (the watcher's event) is no longer part of any closure.
    if (!fs.existsSync(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    const text = fs.readFileSync(file, 'utf8');
    // DO NOT leave out an import for its effect alone (`import './x'`): what it runs is part of the bake as much as what is imported by name.
    const refs = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(refs)) {
      const found = resolve(file, (m[1] ?? m[2] ?? m[3] ?? m[4])!);
      if (found) visit(found);
    }
  };
  visit(path.join(root, entry));
  return [...seen].sort();
}
const DIR = 'cooked';

/** The fingerprint of a derived kind (`DERIVED`): its maker's import closure and the files it also reads. */
function derivedHash(root: string, entry: string, also: readonly string[] = []): string {
  const hash = createHash('sha256');
  for (const file of importClosure(root, entry)) {
    if (!fs.existsSync(file)) continue;
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  for (const file of also) {
    const at = path.join(root, file);
    if (fs.existsSync(at)) hash.update(fs.readFileSync(at, 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 16);
}

/** Refuses to build a game without the cast's people. */
function checkCooked(root: string, stampWanted: string, dir: CookDir): void {
  const manifest = path.join(root, DIR, dir, 'manifest.json');
  const fix = 'Run `npm run cook:people` with the development server up (`npm run dev`) and build again.';
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `No cooked people in ${DIR}/${dir}: this build would build every person during play (21-92 ms each). ${fix}`,
    );
  }
  const stamp = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { hash?: string }).hash;
  if (stamp !== stampWanted) {
    throw new Error(
      `The cooked people in ${DIR}/${dir} are not the cast's: cooked as ${stamp ?? '(no version)'}, the cast is ${stampWanted}. ${fix}`,
    );
  }
}

export function cookPlugin(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  const derived =(): Map<string, string> => new Map(DERIVED.map((d) => [d.define, derivedHash(root, d.entry, d.also)]));
  let derivedHashes = new Map<string, string>();
  const stampOf = (dir: CookDir): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(root, DIR, dir, 'manifest.json'), 'utf8')) as { hash?: string }).hash;
    } catch {
      return undefined;
    }
  };
  let building = false;
  /** The build is a server-side bundle (the desktop's job host): nothing to copy beside it. */
  let serverSide = false;
  let checked = false;
  return {
    name: 'roadcraft-cook',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      derivedHashes = derived();
      return {
        define: {
          ...Object.fromEntries(COOKS.map((c) => [c.define, JSON.stringify(c.stamp)])),
          ...Object.fromEntries([...derivedHashes].map(([name, value]) => [name, JSON.stringify(value)])),
        },
      };
    },
    // A release build refuses a missing cast; a dev server must still start, because cooking it needs one running.
    buildStart() {
      if (!building || checked) return;
      checked = true;
      for (const c of COOKS) checkCooked(root, c.stamp, c.dir);
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
      building = resolved.command === 'build';
      // DO NOT copy the cast into a server-side build (`desktop-jobs.config.ts`): the job host reads none of it, and the 170 MB went into the package twice (AST-04).
      serverSide = Boolean(resolved.build.ssr);
    },
    configureServer(server) {
      // A change to how a derived kind is made changes its fingerprint: the server restarts with the new one
      const watched = DERIVED.flatMap((d) => importClosure(root, d.entry));
      server.watcher.on('change', (file) => {
        if (!watched.some((w) => path.resolve(file).startsWith(path.resolve(w)))) return;
        const nowDerived = derived();
        if ([...nowDerived].some(([name, value]) => derivedHashes.get(name) !== value)) void server.restart();
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
      if (serverSide) return;
      for (const c of COOKS) {
        if (stampOf(c.dir) !== c.stamp) continue;
        const from = path.join(root, DIR, c.dir);
        const to = path.join(outDir, DIR, c.dir);
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
      }
    },
  };
}
