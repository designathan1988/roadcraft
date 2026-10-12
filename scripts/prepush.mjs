// THE PRE-PUSH GATE (.githooks/pre-push, `git config core.hooksPath .githooks`,
// set by `npm run setup`). Git calls the hook with the pushed refs on stdin and
// aborts the push on a non-zero exit (git docs, githooks "pre-push").
//
// 1. `npm run check` (lint, types, knip, specs, architecture, scale, build).
// 2. When the push changes more than documents: the performance and picture
//    gate, base = a production build of the remote's commit (from `git archive`,
//    kept by hash), candidate = a production build of the commit pushed.
// A busy machine ends the gate with "NÃO VERIFICADO: máquina ocupada" and a
// non-zero exit: the push waits, it is never skipped.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ZERO = /^0+$/;
const BUILDS = 'C:/Codex-Shared/roadcraft-2-gate-builds';
const input = readFileSync(0, 'utf8').trim();
const pushes = input ? input.split('\n').map((l) => l.split(' ')) : [];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (cmd, args, { cwd = process.cwd(), env = {} } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  child.on('exit', (code) => resolve(code ?? 1));
});

/** A production build of both modes of commit `sha`, made once and kept by hash. */
async function build(sha) {
  const out = join(BUILDS, sha);
  const dist = join(out, 'dist');
  if (existsSync(join(dist, 'index.html'))) return dist;
  const src = join(out, 'src');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  // The commit's files written out by git itself (a scratch index, then
  // `checkout-index` into the folder): no tar, whose Git Bash build reads
  // "C:/..." as a remote host.
  const env = { ...process.env, GIT_INDEX_FILE: join(out, 'index') };
  execFileSync('git', ['read-tree', sha], { env });
  execFileSync('git', ['--work-tree', src, 'checkout-index', '--all', '--force'], { env });
  // The cooked people are not committed (regenerated): this checkout's, which
  // the build accepts only under the fingerprint of the commit's own code.
  if (existsSync('cooked')) cpSync('cooked', join(src, 'cooked'), { recursive: true });
  if ((await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: src, env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } })) !== 0) throw new Error(`npm ci ${sha}`);
  if ((await run('node', ['scripts/build-modes.mjs', dist], { cwd: src })) !== 0) throw new Error(`build ${sha}`);
  return dist;
}

if (pushes.length === 0) process.exit(0);
if (git('status', '--porcelain') !== '') {
  console.error('pre-push: há mudanças não commitadas; o portão mede o commit, não a pasta. Commit ou descarte antes.');
  process.exit(1);
}
console.error('pre-push: npm run check');
// The whole check takes some 20 minutes here; `run-limited` stops a job at 8 by default.
if ((await run('npm', ['run', 'check'], { env: { RUN_LIMITED_TIMEOUT_S: '3600' } })) !== 0) process.exit(1);

for (const [, localSha, , remoteSha] of pushes) {
  if (ZERO.test(localSha)) continue;
  const base = ZERO.test(remoteSha) ? git('rev-parse', 'origin/main') : remoteSha;
  const changed = git('diff', '--name-only', base, localSha).split('\n').filter(Boolean);
  if (changed.every((f) => f.startsWith('docs/') || f.endsWith('.md') || f.startsWith('gate/baseline/'))) {
    console.error(`pre-push: ${changed.length} arquivos, só documentos: o portão de desempenho não muda com eles.`);
    continue;
  }
  console.error(`pre-push: portão ${base.slice(0, 8)} (base) × ${localSha.slice(0, 8)} (candidato)`);
  const [a, b] = [await build(base), await build(localSha)];
  // One heavy job at a time on the player's machine: the gate waits its turn too.
  // Up to 12 rounds of ~10 min in each mode when a metric stays suspicious: 5 h.
  const code = await run('node', ['scripts/run-limited.mjs', '--kill-gb=1.2', '--min-free-gb=4', 'node', 'scripts/gate/serve-and-gate.mjs', a, b], { env: { RUN_LIMITED_TIMEOUT_S: '18000' } });
  if (code !== 0) process.exit(code);
}
process.exit(0);
