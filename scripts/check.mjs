// THE CHECK (`npm run check`; `npm run check:all` before a push, `.githooks/pre-push`; and at the end of a
// conversation's turn that changed code, `scripts/gate.mjs`). Every step has a hard limit (past it the
// whole process tree is killed and the step fails), the run stops at the first failure and prints the
// seconds of each step. Nothing here plays the game, times anything or retries.
//   lint    ESLint (layers, file size, no silent catch, no module state), cached by file content
//   code    scripts/check-code.mjs: the types and the code rules over the call graph of a frame
//   knip    no unused file, export or dependency
//   unit    vitest: every spec, each test at most 10 s; the static rules of the code and of the tests
//           (tests/arch)
//   scale   the counting suites (tests/perf, tests/scale): the same edit costs the same on any map
//   build   vite build
// What runs depends on what changed (git: the working tree against HEAD, untracked files included):
// docs only → nothing; tests only → everything but the build; anything else → everything.
// `--all` runs every step whatever changed (the pre-push, which checks the commit being pushed).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

/** Files of the working tree that differ from HEAD, untracked ones included; null outside a repository. */
function changed() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  try {
    return [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
  } catch (error) {
    console.error(`check: git could not list the changes (${error.message.split('\n')[0]}); every step runs`);
    return null;
  }
}

/** A file whose change cannot change what any step sees. */
export const isDoc = (f) => f.startsWith('docs/') || f.endsWith('.md');
/** A file only the specs read. */
export const isTest = (f) => f.startsWith('tests/');

/** The steps a set of changed files calls for (`null`: every step). */
export function stepsFor(files) {
  const all = ['lint', 'code', 'knip', 'unit', 'scale', 'build'];
  if (!files) return all;
  const relevant = files.filter((f) => !isDoc(f));
  if (!relevant.length) return [];
  if (relevant.every(isTest)) return all.filter((s) => s !== 'build');
  return all;
}

/**
 * The ESLint cache, keyed on what decides a result besides the file itself: the config, the project's own
 * rules and the installed versions (ESLint keys its cache on the file and the config only). No rule here
 * reads another file or the types, so a file's result depends on that file alone (eslint.org, "Caching").
 */
function eslintCache() {
  const h = createHash('sha1');
  for (const f of ['eslint.config.js', 'package-lock.json', 'eslint-suppressions.json']) h.update(readFileSync(join(ROOT, f)));
  for (const f of readdirSync(join(ROOT, 'eslint-rules')).sort()) h.update(f).update(readFileSync(join(ROOT, 'eslint-rules', f)));
  return `node_modules/.cache/eslint/${h.digest('hex').slice(0, 12)}.json`;
}

const STEPS = {
  lint: { limit: 90, cmd: () => [node, 'node_modules/eslint/bin/eslint.js', '.', '--cache', '--cache-strategy', 'content', '--cache-location', eslintCache()] },
  code: { limit: 60, cmd: () => [node, 'scripts/check-code.mjs'] },
  knip: { limit: 60, cmd: () => [node, 'scripts/knip-check.mjs'] },
  unit: { limit: 180, cmd: () => [node, 'node_modules/vitest/vitest.mjs', 'run'] },
  scale: { limit: 90, cmd: () => [node, 'node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.scale.config.ts'] },
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
  const files = process.argv.includes('--all') ? null : changed();
  const steps = stepsFor(files);
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
