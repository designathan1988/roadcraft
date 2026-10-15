// BROKEN PATHS IN COMMENTS AND DOCS, in seconds. Read-only.
//
// A repository path cited in a source file or a document (`src/...`,
// `scripts/...`, `tests/...`, `docs/...`, `memory/...`, `.claude/...`,
// `public/...`) must name a file or folder that exists, with the same case.
// Scanned: .ts .mjs .cjs .js .md, except node_modules, dist, worktrees,
// public (assets) and the historical copies of the old game (docs/source,
// docs/research/source).
//
// What is already broken is listed in `refs.baseline.json` ({"<file>  <path>": count}),
// which only shrinks: the check fails on a broken path not in it and on an
// entry fixed but not taken out.
// node scripts/check-refs.mjs [--update] [--root <dir>] [--list]
// (`--root`: another tree; `--list`: its findings printed as JSON, for the
// script's own test, `tests/arch/checkRefs.spec.ts`.)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const started = performance.now();
const rootAt = process.argv.indexOf('--root');
const root = rootAt >= 0 ? resolve(process.argv[rootAt + 1]) : process.cwd();
const BASELINE = join(root, 'refs.baseline.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'worktrees', '.git']);
const SKIP_PATHS = new Set(['public', 'docs/source', 'docs/research/source']);
const SCANNED = /\.(ts|mjs|cjs|js|md)$/;
/** A repository path: a known top folder, then path characters, ending on a word character. */
const PATH = /(?<![\w./@~\\-])((?:src|scripts|tests|docs|memory|\.claude|public)\/[\w./@-]*\w)/g;
/** What follows a path that is a pattern or a template, not a path: a glob, `${}`, a placeholder. */
const PATTERN_AFTER = /^[./]?[*{$<[]/;

const listings = new Map();
/** Names in a folder, or null when the folder does not exist. */
function listing(dir) {
  if (!listings.has(dir)) {
    const at = join(root, dir);
    listings.set(dir, existsSync(at) && statSync(at).isDirectory() ? new Set(readdirSync(at)) : null);
  }
  return listings.get(dir);
}
/** Whether a relative path exists, with the same case segment by segment (Windows ignores case). */
function exists(path) {
  let dir = '';
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return existsSync(join(root, dir, path));
    const names = listing(dir);
    if (!names || !names.has(part)) return false;
    dir = dir ? `${dir}/${part}` : part;
  }
  return true;
}

const files = [];
function walk(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) walk(rel);
    } else if (SCANNED.test(entry.name)) {
      files.push(rel);
    }
  }
}
walk('');
files.sort();

const issues = {};
const found = [];
for (const file of files) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const match of text.matchAll(PATH)) {
      const path = match[1];
      if (PATTERN_AFTER.test(text.slice(match.index + path.length))) continue;
      if (exists(path)) continue;
      const key = `${file}  ${path}`;
      issues[key] = (issues[key] ?? 0) + 1;
      found.push({ file, line: i + 1, path });
    }
  });
}

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(found));
  process.exit(0);
}

const total = (map) => Object.values(map).reduce((s, n) => s + n, 0);
const stats = `${files.length} files, ${Math.round(performance.now() - started)} ms`;
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const added = Object.keys(issues).filter((key) => issues[key] > (baseline[key] ?? 0));
const gone = Object.keys(baseline).filter((key) => (issues[key] ?? 0) < baseline[key]);
const where = (key) => found.filter((f) => `${f.file}  ${f.path}` === key).map((f) => `${f.file}:${f.line}`).join(', ');
if (process.argv.includes('--update')) {
  if (added.length && existsSync(BASELINE)) {
    for (const key of added) console.error(`new: ${key}  x${issues[key]}\n    ${where(key)}`);
    console.error(`refs: ${added.length} new broken paths; the baseline only shrinks.`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(issues).sort()), null, 1) + '\n');
  console.log(`refs: baseline with ${total(issues)} occurrences in ${Object.keys(issues).length} entries (${stats})`);
  process.exit(0);
}
for (const key of added) console.error(`new: ${key}  x${issues[key]} (baseline ${baseline[key] ?? 0})\n    ${where(key)}`);
if (gone.length) console.error(`refs: ${gone.length} baseline entries fixed or reduced; take them out (node scripts/check-refs.mjs --update):\n${gone.join('\n')}`);
// The baseline is the list of known defects to fix, not an acceptance. DO NOT word this as a pass.
console.log(`refs: ${added.length} novos; ${Object.keys(baseline).length} defeitos conhecidos ainda no código (${total(baseline)} ocorrências na linha de base, a corrigir) (${stats})`);
process.exit(added.length || gone.length ? 1 : 0);
