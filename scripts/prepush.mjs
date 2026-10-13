// THE PRE-PUSH CHECK (.githooks/pre-push, `git config core.hooksPath .githooks`, set by `npm run setup`).
// Git calls the hook with the pushed refs on stdin and aborts the push on a non-zero exit (git docs,
// githooks "pre-push").
//
// It checks the COMMIT being pushed, not the folder: several conversations work in this folder at once,
// and one's unsaved work must neither block another's push nor hide a file the commit forgot. When the
// folder is exactly that commit, the check runs here; otherwise the commit's files are written to a
// temporary folder (`git read-tree` into a temporary index and `git checkout-index`: the real index and
// the folder are not touched), with `node_modules` joined to this one, and the commit's own check runs
// there. `npm run check:all`: every step whatever changed (`scripts/check.mjs`).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const git = (args, env = process.env) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env }).trim();
const ZERO = /^0+$/;

/** Runs the check of the commit in `dir`; its exit code. */
function check(dir) {
  const r = spawnSync(process.execPath, ['scripts/run-limited.mjs', 'node', 'scripts/check.mjs', '--all'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, RUN_LIMITED_TIMEOUT_S: '700' },
  });
  return r.status ?? 1;
}

/**
 * What the commit does not hold but its check reads, joined from this folder: the packages, and the people
 * cooked ahead (`cooked/`, ignored by git; the build refuses stale ones, `cook-plugin.ts`).
 */
const JOINED = ['node_modules', 'cooked'];

/** The commit's files in a temporary folder, joined to this folder's `JOINED`; its check's exit code. */
function checkExported(sha) {
  const dir = join(tmpdir(), `roadcraft-push-${sha.slice(0, 12)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const linked = [];
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, '.push-index') };
    git(['read-tree', sha], env);
    git(['checkout-index', '--all', `--prefix=${dir.replace(/\\/g, '/')}/`], env);
    rmSync(join(dir, '.push-index'));
    for (const name of JOINED) {
      if (!existsSync(join(ROOT, name))) continue;
      symlinkSync(join(ROOT, name), join(dir, name), 'junction');
      linked.push(join(dir, name));
    }
    return check(dir);
  } finally {
    // The junctions first, each on its own: the folders they point to are this repository's.
    for (const link of linked) rmdirSync(link);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const shas = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)
  .map((line) => line.split(' ')[1] ?? '')
  .filter((sha) => sha && !ZERO.test(sha));
for (const sha of new Set(shas)) {
  const here = git(['rev-parse', 'HEAD']) === sha && git(['status', '--porcelain']) === '';
  console.error(`pre-push: npm run check:all on ${sha.slice(0, 12)}${here ? '' : ' (exported: the folder has other changes)'}`);
  const code = here ? check(ROOT) : checkExported(sha);
  if (code !== 0) process.exit(code);
}
