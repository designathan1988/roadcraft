// THE DIAGNOSIS'S OWN GAME: a probe build in a folder of its own and a preview server on a port of its own, so another session saving files
// (the dev server's reloads) never touches the run. The build is made again only when a source it is made from is newer than it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve('.');
/** Under `.cache/` (ignored by git): the build never lands in the repository. */
export const DIST = join(ROOT, '.cache', 'diagnose-dist');
export const PORT = 5302;
const STAMP = join(DIST, '.diagnose-built');

/** What the build is made from: the game's sources, its page, its config and its build plugins, the cooked assets. */
const SOURCES = ['src', 'index.html', 'vite.config.ts', 'scripts/vite', 'cooked', 'package-lock.json'];

/** The newest modification time under `path`, ms. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  let most = s.mtimeMs;
  for (const name of readdirSync(path)) most = Math.max(most, newest(join(path, name)));
  return most;
}

/** Whether the build is older than any of its sources (or missing). */
export function buildStale() {
  if (!existsSync(STAMP)) return true;
  const built = Number(readFileSync(STAMP, 'utf8'));
  return SOURCES.some((p) => newest(join(ROOT, p)) > built);
}

/** Runs a command to its end; its output shown only when it fails (a build lists every chunk it wrote). */
function run(command, args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: { ...process.env, ...env } });
    let said = '';
    child.stdout.on('data', (d) => { said += d; });
    child.stderr.on('data', (d) => { said += d; });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited ${code}:\n${said.slice(-4000)}`))));
    child.on('error', fail);
  });
}

/** The probe build (`--mode probe`: `__roadcraft`, `__gpu`, `__frames` kept) made into DIST when stale; the seconds it took, or 0. */
export async function ensureBuild({ force = false } = {}) {
  if (!force && !buildStale()) return 0;
  // The time read BEFORE building: a source saved during the build makes the next run build again.
  const started = Date.now();
  await run('npx', ['vite', 'build', '--mode', 'probe', '--outDir', DIST, '--emptyOutDir']);
  writeFileSync(STAMP, String(started));
  return (Date.now() - started) / 1000;
}

/** The preview server of DIST on PORT, answering; `close()` ends it. */
export async function startServer() {
  const child = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let said = '';
  child.stdout.on('data', (d) => { said += d; });
  child.stderr.on('data', (d) => { said += d; });
  const url = `http://127.0.0.1:${PORT}/`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the preview server ended (${child.exitCode}): ${said.trim().slice(-400)}`);
    try { if ((await fetch(url)).ok) break; } catch (error) { if (!(error instanceof TypeError)) throw error; }
    if (Date.now() - t0 > 30_000) throw new Error(`the preview server did not answer at ${url} in 30 s: ${said.trim().slice(-400)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    close: () => new Promise((done) => {
      if (child.exitCode !== null) return done();
      child.on('exit', () => done());
      // `shell` on Windows: the server is a child of the shell; its whole tree ended.
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill();
    }),
  };
}
