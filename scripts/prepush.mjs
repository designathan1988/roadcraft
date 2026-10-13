// THE PRE-PUSH CHECK (.githooks/pre-push, `git config core.hooksPath .githooks`,
// set by `npm run setup`). Git calls the hook with the pushed refs on stdin and
// aborts the push on a non-zero exit (git docs, githooks "pre-push").
//
// `npm run check`: lint (layers, file size, silent catch, module state), types,
// knip, the specs that run in seconds (each test capped at 10 s; the slow ones
// are in `tests/slow.json` and never run here), architecture, the counting
// suites and the build. About a minute; nothing here opens the game.
// The performance gate that played the game in Chrome for hours before each
// push is gone (the player, 2026-10-13; docs/research/regression-barrier.md).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8').trim();
if (!input) process.exit(0);
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '') {
  console.error('pre-push: há mudanças não commitadas; o check verifica o commit, não a pasta. Commit ou descarte antes.');
  process.exit(1);
}
console.error('pre-push: npm run check');
const child = spawn('npm', ['run', 'check'], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, RUN_LIMITED_TIMEOUT_S: '600' } });
child.on('exit', (code) => process.exit(code ?? 1));
