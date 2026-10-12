import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

/**
 * WHICH BUILD IS ON THE SCREEN. Branch, short commit and commit date of the
 * checkout the server runs from, plus `dirty` when it has uncommitted edits.
 *
 * A round of fixes once lived on a branch while the player ran master, and
 * every "fixed" was false on their screen. The development server answers
 * `/__build` afresh on every request, so the stamp stays right after a
 * fast-forward without a restart; a production build bakes it in.
 */
export interface BuildStamp {
  readonly branch: string;
  readonly hash: string;
  readonly date: string;
  readonly dirty: boolean;
}

/** The git binary: on PATH, or where Git for Windows installs it (a server started from a shell without it on PATH once stamped every build "unknown"). */
const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'];

function git(args: string[]): string {
  for (const binary of GIT_CANDIDATES) {
    try {
      return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

/**
 * Branch and commit read straight from the `.git` files, for when no git
 * binary can be run at all. Handles a linked worktree (`.git` is a file
 * pointing at its gitdir, whose `commondir` holds the refs) and packed refs.
 */
function readGitFiles(start = process.cwd()): { branch: string; hash: string } | null {
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const pointer = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        gitDir = path.resolve(dir, pointer[1]!.trim());
      }
      const commonFile = path.join(gitDir, 'commondir');
      const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
      if (!ref) return { branch: 'HEAD', hash: head.slice(0, 7) };
      const loose = [path.join(gitDir, ref), path.join(common, ref)].find((file) => fs.existsSync(file));
      let hash = loose ? fs.readFileSync(loose, 'utf8').trim() : '';
      if (!hash) {
        const packed = path.join(common, 'packed-refs');
        const line = fs.existsSync(packed) ? fs.readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`)) : undefined;
        hash = line?.split(' ')[0] ?? '';
      }
      return { branch: ref.replace(/^refs\/heads\//, ''), hash: hash.slice(0, 7) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readBuildStamp(): BuildStamp {
  const files = readGitFiles();
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || files?.branch || 'unknown',
    hash: git(['rev-parse', '--short', 'HEAD']) || files?.hash || 'unknown',
    date: git(['log', '-1', '--format=%cI']) || '',
    dirty: git(['status', '--porcelain', '--untracked-files=no']).length > 0,
  };
}

/** `git` without waiting for it (Node: the `*Sync` calls block the event loop until the child exits). */
const gitLater = promisify(execFile);
async function gitAsync(args: string[]): Promise<string> {
  for (const binary of GIT_CANDIDATES) {
    try {
      return (await gitLater(binary, args, { encoding: 'utf8' })).stdout.trim();
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

/** `readBuildStamp`, its four git runs side by side and none of them blocking. */
async function readBuildStampLater(): Promise<BuildStamp> {
  const [branch, hash, date, status] = await Promise.all([
    gitAsync(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitAsync(['rev-parse', '--short', 'HEAD']),
    gitAsync(['log', '-1', '--format=%cI']),
    gitAsync(['status', '--porcelain', '--untracked-files=no']),
  ]);
  const files = branch && hash ? null : readGitFiles();
  return { branch: branch || files?.branch || 'unknown', hash: hash || files?.hash || 'unknown', date, dirty: status.length > 0 };
}

/** How old an answered stamp may be before it is read again, ms. */
const STAMP_FRESH_MS = 3000;

export function buildStampPlugin(): Plugin {
  return {
    name: 'roadcraft-build-stamp',
    config: () => ({ define: { __BUILD_STAMP__: JSON.stringify(readBuildStamp()) } }),
    configureServer(server) {
      // Answered from the last stamp read, read again behind the answer when
      // it is a few seconds old: four synchronous git runs per request held
      // the server 0.4 s every five seconds for every open tab, the game's
      // own modules waiting behind them.
      let stamp: BuildStamp | null = null;
      let readAt = 0;
      let reading: Promise<void> | null = null;
      const refresh = (): Promise<void> => (reading ??= readBuildStampLater()
        .then((next) => { stamp = next; readAt = Date.now(); })
        .finally(() => { reading = null; }));
      server.middlewares.use('/__build', (_req, res) => {
        const answer = (): void => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(stamp));
        };
        if (!stamp) { void refresh().then(answer); return; }
        if (Date.now() - readAt > STAMP_FRESH_MS) void refresh();
        answer();
      });
    },
  };
}
