// THE VERIFICATION IN SECONDS (`npm run verify`): what the change touched, never the whole suite.
//  1. types: the native TypeScript compiler (`tsgo`, @typescript/native-preview: ~2 s for the whole program, where `tsc` takes ~12 s);
//  2. lint: ESLint on the changed files only (a file's result depends on that file alone);
//  3. specs: only those that import the changed code (`vitest related`, Vitest's static module graph), stopped at the first failure;
//     and always the goldens: the city a seed makes and the driving and walking of a seed, bit for bit (Factorio's per-tick CRC, in seconds),
//     and the census of the derived world (tests/census: what the buildings' layer, the gardens and the trees make of the small city, in Node, no GPU);
//  4. the game itself: the small city opened in headless Chrome (`scripts/look/verify.json`), map, district and street photographed,
//     failing on any page error, console error or lost WebGL context, each photo compared with the reference (`lab-reports/verify-ref`).
// `--game`: also step 4 (the browser, the photos); `--ref` with it: the photos taken now become the reference (after a change seen and approved).
// The big city, the timings and the whole suite are not here: they are for the milestones, not for every change.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const makeRef = args.includes('--ref');
/** The game opened in a browser only when asked (`--game`): a change of the picture itself; everything else is proven in Node, in seconds. */
const noGame = !args.includes('--game');
/** Share of a photo's pixels that may differ from the reference: the cars and the trees in the wind move between two runs (0.1-0.4 %). */
const MOST_CHANGED = 0.015;
const REF = join(ROOT, 'lab-reports', 'verify-ref');
const NOW = join(ROOT, 'lab-reports', 'verify-now');

const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])]
  .filter((f) => existsSync(join(ROOT, f)));
const code = changed.filter((f) => /\.(ts|mjs|js|cjs)$/.test(f) && !f.startsWith('lab-reports/'));

const bin = (name) => join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
function run(name, cmd, cmdArgs) {
  const t0 = Date.now();
  return new Promise((done) => {
    let out = '';
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, shell: process.platform === 'win32' });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => done({ name, ok: status === 0, out, s: (Date.now() - t0) / 1000 }));
  });
}

const t0 = Date.now();
const specs = code.filter((f) => f.startsWith('src/') || f.startsWith('tests/'));
const steps = [run('types (tsgo)', bin('tsgo'), ['--noEmit', '-p', 'tsconfig.json'])];
if (code.length) steps.push(run(`lint (${code.length} files)`, bin('eslint'), ['--cache', '--cache-location', 'node_modules/.cache/eslint-verify', '--suppressions-location', 'scripts/baselines/eslint-suppressions.json', ...code]));
steps.push(run('goldens and census (city, driving, walking, the derived world)', bin('vitest'), ['run', 'tests/world/cityGolden.spec.ts', 'tests/sim/drivingGolden.spec.ts', 'tests/sim/walkingGolden.spec.ts', 'tests/census/worldCensus.spec.ts']));
if (specs.length) steps.push(run('specs of the change', bin('vitest'), ['related', '--run', '--bail', '1', '--passWithNoTests', ...specs]));
const results = await Promise.all(steps);
let failed = false;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.s.toFixed(1)} s)`);
  if (!r.ok) { failed = true; console.log(r.out.split('\n').filter((l) => l.trim()).slice(-40).join('\n')); }
}

if (!noGame && !failed) {
  rmSync(NOW, { recursive: true, force: true });
  mkdirSync(NOW, { recursive: true });
  const look = await run('the game opened (small city)', process.execPath, [join(ROOT, 'scripts', 'look.mjs'), join(ROOT, 'scripts', 'look', 'verify.json'), NOW]);
  const report = existsSync(join(NOW, 'report.json')) ? JSON.parse(readFileSync(join(NOW, 'report.json'), 'utf8')) : null;
  // The page's own errors; DO NOT fail on the driver's shader-compiler notes (X4122, a precision remark of D3D's compiler).
  const errors = (report?.console ?? []).filter((m) => (m.startsWith('error') || m.startsWith('pageerror')) || /context lost/i.test(m));
  const ok = look.ok && report && errors.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${look.name} (${look.s.toFixed(1)} s)`);
  if (!ok) { failed = true; console.log(errors.join('\n') || look.out.split('\n').slice(-20).join('\n')); }
  if (ok && makeRef) {
    rmSync(REF, { recursive: true, force: true });
    cpSync(NOW, REF, { recursive: true });
    console.log(`reference kept: ${REF}`);
  } else if (ok && existsSync(REF)) {
    const cmp = await run('photos against the reference', process.execPath, [join(ROOT, 'scripts', 'look-compare.mjs'), REF, NOW]);
    const rows = existsSync(join(NOW, 'comparison', 'comparison.json')) ? JSON.parse(readFileSync(join(NOW, 'comparison', 'comparison.json'), 'utf8')) : [];
    const worst = rows.reduce((m, r) => Math.max(m, r.share ?? 1), 0);
    const pass = cmp.ok && rows.length > 0 && worst <= MOST_CHANGED;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${cmp.name}: worst ${(worst * 100).toFixed(2)} % of pixels changed (limit ${(MOST_CHANGED * 100).toFixed(1)} %) (${cmp.s.toFixed(1)} s)`);
    for (const r of rows) console.log(`     ${r.name}: ${((r.share ?? 1) * 100).toFixed(2)} %`);
    if (!pass) failed = true;
  } else if (ok) console.log('     no reference yet: `npm run verify -- --ref` once the picture is approved');
  console.log(`photos: ${readdirSync(NOW).filter((n) => n.endsWith('.png')).map((n) => join(NOW, n)).join('\n        ')}`);
}
console.log(`${failed ? 'FAILED' : 'PASSED'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
