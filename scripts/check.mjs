// THE CHECK (`npm run check`; `npm run check:all` before a push; `--fast`: the barrier only, see `stepsFor`).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

/** DO NOT check a committed block against HEAD: it saw nothing and ran no step. */
function changed(base) {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  try {
    const from = base ? git(['merge-base', base, 'HEAD'])[0] : 'HEAD';
    return [...new Set([...git(['diff', '--name-only', from]), ...git(['ls-files', '--others', '--exclude-standard'])])];
  } catch (error) {
    console.error(`check: git could not list the changes (${error.message.split('\n')[0]}); every step runs`);
    return null;
  }
}

/** A file whose change cannot change what any step sees. */
export const isDoc = (f) => f.startsWith('docs/') || f.endsWith('.md');
/** A file only the specs read. */
export const isTest = (f) => f.startsWith('tests/');

/** DO NOT put tests back in the turn's check. */
export function stepsFor(files, fast = false) {
  const all = fast ? ['lint', 'code'] : ['lint', 'code', 'knip', 'unit', 'scale', 'build'];
  if (!files) return all;
  const relevant = files.filter((f) => !isDoc(f));
  if (!relevant.length) return [];
  if (relevant.every(isTest)) return all.filter((s) => s !== 'build');
  return all;
}

/** The changed files ESLint reads, for the fast check (a file's result depends on that file alone, see below). */
const lintable = (files) => files.filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && existsSync(join(ROOT, f)));

/** The ESLint cache, keyed on what decides a result besides the file itself */
function eslintCache() {
  const h = createHash('sha1');
  for (const f of ['eslint.config.js', 'package-lock.json', 'scripts/baselines/eslint-suppressions.json']) h.update(readFileSync(join(ROOT, f)));
  for (const f of readdirSync(join(ROOT, 'eslint-rules')).sort()) h.update(f).update(readFileSync(join(ROOT, 'eslint-rules', f)));
  return `node_modules/.cache/eslint/${h.digest('hex').slice(0, 12)}.json`;
}

/** The specs that read the code or the page as text (through the file system, not by importing it) */
export const ALWAYS = [
  'tests/arch/', 'tests/tooling/', 'tests/ui/decimals.spec.ts', 'tests/ui/i18n.spec.ts', 'tests/ui/i18nKeys.spec.ts',
  'tests/ui/oldInterface.spec.ts', 'tests/render/citizenLod.spec.ts', 'tests/render/vehicleFrame.spec.ts',
  'tests/render/warmLoose.spec.ts',
  'tests/render/groundDigest.spec.ts',
  'tests/world/buildings.spec.ts',
  'tests/world/cellFilingAny.spec.ts',
  'tests/world/buildingNearAny.spec.ts',
  'tests/render/paintCatalogue.spec.ts',
  'tests/render/gardenMatrix.spec.ts',
  'tests/render/roadLod.spec.ts',
  'tests/render/cheapAudit.spec.ts',
  'tests/editor/history.spec.ts',
  'tests/editor/lotProposalPlace.spec.ts',
  'tests/editor/tileStore.spec.ts',
  'tests/editor/worldStreamer.spec.ts',
  'tests/render/canyonLight.spec.ts',
  'tests/render/frameBudget.spec.ts',
  'tests/render/layerIncremental.spec.ts',
  'tests/render/openingNature.spec.ts',
  'tests/render/programsGate.spec.ts',
  'tests/render/textureUploads.spec.ts',
  'tests/ui/statusScope.spec.ts',
  'tests/core/derivedDurability.spec.ts',
  'tests/render/cellHoles.spec.ts',
];

/** The specs a change calls for: `null` */
export function specsFor(files) {
  if (!files) return null;
  const existing = files.filter((f) => !isDoc(f) && existsSync(join(ROOT, f)));
  // `related` matches whole paths: a folder of `ALWAYS` stands for each spec in it.
  const specs = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? specs(`${dir}${e.name}/`) : e.name.endsWith('.spec.ts') ? [`${dir}${e.name}`] : []);
  const always = ALWAYS.flatMap((a) => (a.endsWith('/') ? specs(a) : [a]));
  return [...new Set([...existing, ...always])];
}

/** The specs that import a changed source file themselves */
export function directSpecsFor(files) {
  const specs = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? specs(`${dir}${e.name}/`) : e.name.endsWith('.spec.ts') ? [`${dir}${e.name}`] : []);
  const stems = files.filter((f) => f.startsWith('src/') && /\.ts$/.test(f)).map((f) => f.slice(4).replace(/(\/index)?\.ts$/, ''));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imports = (text, stem) => new RegExp(`['"](?:@|[./]*src/)${esc(stem)}(?:\\.ts)?['"]`).test(text);
  // A spec of the file's own area that names it (`ambient.enabled`), when no spec imports it by itself.
  const names = (text, stem) => new RegExp(`\\b${esc(stem.split('/').pop())}\\b`).test(text);
  const area = (stem) => `tests/${stem.split('/')[0]}/`;
  const own = [];
  const texts = stems.length ? specs('tests/').map((s) => [s, readFileSync(join(ROOT, s), 'utf8')]) : [];
  for (const stem of stems) {
    let mine = texts.filter(([, t]) => imports(t, stem)).map(([s]) => s);
    // A file the whole game reads (`world/doc.ts`: ~170 specs import it): the specs of its own area.
    if (mine.length > 40) mine = mine.filter((s) => s.startsWith(area(stem)));
    if (!mine.length) mine = texts.filter(([s, t]) => s.startsWith(area(stem)) && names(t, stem)).map(([s]) => s);
    own.push(...mine);
  }
  const always = ALWAYS.flatMap((a) => (a.endsWith('/') ? specs(a) : [a]));
  return [...new Set([...files.filter((f) => f.endsWith('.spec.ts') && existsSync(join(ROOT, f))), ...own, ...always])];
}

/** `vitest run` for every spec (or the listed ones), `vitest related --run` for those a change reaches. */
function vitest(config, specs, direct = false) {
  const base = [node, 'node_modules/vitest/vitest.mjs', ...(config ? ['-c', config] : [])];
  if (direct) return [...base, 'run', ...specs];
  return specs ? [...base, 'related', '--run', ...specs] : [...base, 'run'];
}

/** The changed files (null: everything), and whether the check is the fast one, set once by `main`. */
let picked = null;
let fastRun = false;

const STEPS = {
  lint: {
    limit: 90,
    cmd: () => [node, 'node_modules/eslint/bin/eslint.js', ...(fastRun && picked ? lintable(picked) : ['.']), '--no-warn-ignored', '--suppressions-location', 'scripts/baselines/eslint-suppressions.json',
      '--cache', '--cache-strategy', 'content', '--cache-location', eslintCache()],
  },
  code: { limit: 60, cmd: () => [node, 'scripts/check-code.mjs'] },
  knip: { limit: 60, cmd: () => [node, 'scripts/knip-check.mjs'] },
  unit: { limit: 180, cmd: () => (fastRun && picked ? vitest(null, directSpecsFor(picked), true) : vitest(null, specsFor(picked))) },
  scale: { limit: 90, cmd: () => vitest('vitest.scale.config.ts', specsFor(picked)) },
  build: { limit: 90, cmd: () => [node, 'node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'] },
};

/** Runs a step; past its limit the whole process tree is killed and the step fails. */
function run(name) {
  const { limit, cmd } = STEPS[name];
  const [exe, ...args] = cmd();
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(exe, args, { cwd: ROOT, stdio: 'inherit' });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, limit * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      done({ name, ok: code === 0 && !late, s, why: late ? `passed its limit of ${limit} s` : code === 0 ? '' : `exit ${code}` });
    });
  });
}

async function main() {
  const at = process.argv.indexOf('--base');
  const files = process.argv.includes('--all') ? null : changed(at > 0 ? process.argv[at + 1] : undefined);
  picked = files;
  fastRun = process.argv.includes('--fast');
  const steps = stepsFor(files, fastRun).filter((s) => s !== 'lint' || !fastRun || !files || lintable(files).length);
  console.log(files ? `changed: ${files.length ? files.join(', ') : 'nothing'}` : 'changed: everything (--all)');
  console.log(`steps: ${steps.join(', ') || 'none (docs only)'}`);
  const t0 = Date.now();
  const report = [];
  for (const name of steps) {
    console.log(`\n── ${name}`);
    const r = await run(name);
    report.push(r);
    if (!r.ok) break;
  }
  console.log('\ncheck:');
  for (const r of report) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(6)} ${r.s.padStart(6)} s${r.why ? `  (${r.why})` : ''}`);
  console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return report.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
