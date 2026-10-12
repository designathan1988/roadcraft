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
  execFileSync('git', ['archive', '--format=tar', '-o', join(out, 'src.tar'), sha]);
  execFileSync('tar', ['-xf', join(out, 'src.tar'), '-C', src]);
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
if ((await run('npm', ['run', 'check'])) !== 0) process.exit(1);

for (const [, localSha, , remoteSha] of pushes) {
  if (ZERO.test(localSha)) continue;
  const base = ZERO.test(remoteSha) ? git('rev-parse', 'origin/main') : remoteSha;
  const changed = git('diff', '--name-only', base, localSha).split('\n').filter(Boolean);
  if (changed.every((f) => f.startsWith('docs/') || f.endsWith('.md') || f.startsWith('gate/baseline/'))) {
    console.error(`pre-push: ${changed.length} arquivos, só documentos: o portão de desempenho não muda com eles.`);
    continue;
  }
  console.error(`pre-push: portão ${base.slice(0, 8)} (base) × ${localSha.slice(0, 8)} (candidato)`);
  const code = await run('node', ['scripts/gate/serve-and-gate.mjs', await build(base), await build(localSha)]);
  if (code !== 0) process.exit(code);
}
process.exit(0);
