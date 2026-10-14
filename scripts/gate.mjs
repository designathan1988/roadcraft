// THE GATE OF A CLAUDE CODE CONVERSATION (hooks in `.claude/settings.json`): a turn that changed code does
// not end while `npm run check` is red. CLAUDE.md asks for the check; this makes it happen.
//   node scripts/gate.mjs touch   PostToolUse on Edit|Write|NotebookEdit: notes that this conversation
//                                 changed a file of the project other than docs.
//   node scripts/gate.mjs stop    Stop: when this conversation changed something since its last green check,
//                                 runs the check; red blocks the end of the turn (exit 2: the reason goes to
//                                 Claude, code.claude.com/docs/en/hooks "Stop decision control").
// Cheap when there is nothing to check: no change by this conversation, no run. A red check runs once per
// state of the files (the fingerprint of HEAD, the diff and the untracked files): the same state blocks again
// from the stored result, and when Claude is already continuing because of this hook (`stop_hook_active`)
// after a red, the check runs once more (a red can pass: another conversation's half-saved file) and,
// still red, the turn ends with a warning to the player instead of a loop. Not seen: files changed by
// shell commands only (sed, git rm); whoever does that runs `npm run check` by hand.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'node_modules/.cache/claude-gate');

/** A project file whose change can change what the check sees (docs and notes cannot). */
export function counts(file, root = ROOT) {
  const r = relative(root, file).split(sep).join('/');
  if (!r || r.startsWith('..') || /^[a-zA-Z]:/.test(r)) return false;
  return !(r.startsWith('docs/') || r.endsWith('.md') || r.startsWith('node_modules/') || r.startsWith('.git/'));
}

/**
 * What the Stop hook does: `skip` (nothing of this conversation to check), `run`, `block` (the same files as
 * a red check already seen: block again with its result) or `warn` (red, and Claude is already continuing
 * because of this hook: the check runs once more and, still red, the turn ends with a warning to the
 * player). Other conversations edit this folder too, so the files rarely stay the same between two stops:
 * the second red of a continued turn ends it, whatever changed, and a turn costs at most two runs.
 */
export function decide({ touched, fingerprint, failed, active }) {
  if (!touched) return 'skip';
  if (failed && active) return 'warn';
  if (failed && failed.fingerprint === fingerprint) return 'block';
  return 'run';
}

/** The state of the working tree: the commit, the changes to it and the untracked files with their contents. */
function fingerprint() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 << 20 });
  const h = createHash('sha1');
  h.update(git(['rev-parse', 'HEAD']));
  h.update(git(['diff', 'HEAD', '--binary']));
  for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
    h.update(f);
    if (existsSync(join(ROOT, f))) h.update(readFileSync(join(ROOT, f)));
  }
  return h.digest('hex');
}

/** The hook's input (JSON on stdin); an empty object when there is none (run by hand). */
function input() {
  const text = readFileSync(0, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

/**
 * The fast check (`scripts/check.mjs --fast`: the changed files linted, types and code rules, the specs
 * the change reaches, the counting suites) under the machine's lock, ending before the hook's own timeout
 * (`.claude/settings.json`). DO NOT run the whole `npm run check` here: a turn held for minutes is what
 * the player removed (2026-10-14); the bundle and the unused-export sweep stay in `npm run check`.
 */
function check() {
  return spawnSync(process.execPath, ['scripts/run-limited.mjs', 'node', 'scripts/check.mjs', '--fast'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 170_000,
    maxBuffer: 64 << 20,
    env: { ...process.env, RUN_LIMITED_WAIT_S: '30', RUN_LIMITED_TIMEOUT_S: '130' },
  });
}

function main(mode) {
  const hook = input();
  const id = String(hook.session_id || 'none').replace(/[^\w-]/g, '_');
  const mark = join(DIR, `${id}.touched`);
  const fail = join(DIR, `${id}.failed.json`);
  mkdirSync(DIR, { recursive: true });

  if (mode === 'touch') {
    const file = hook.tool_input?.file_path || hook.tool_input?.notebook_path;
    if (file && counts(file)) writeFileSync(mark, file);
    return 0;
  }
  if (mode !== 'stop') {
    process.stderr.write(`gate: unknown mode ${mode} (touch | stop)\n`);
    return 1;
  }

  const failed = existsSync(fail) ? JSON.parse(readFileSync(fail, 'utf8')) : null;
  const fp = existsSync(mark) ? fingerprint() : '';
  const what = decide({ touched: existsSync(mark), fingerprint: fp, failed, active: !!hook.stop_hook_active });
  if (what === 'skip') return 0;
  let reason = failed?.reason;
  if (what === 'run' || what === 'warn') {
    const r = check();
    // The machine busy with another session's heavy job (`run-limited.mjs`): the check did not run, which is
    // no red. The turn ends, and says so.
    if (/\[run-limited\] gave up/.test(r.stderr ?? '')) {
      process.stdout.write(JSON.stringify({ systemMessage: 'Checagem rápida não rodou: a máquina estava ocupada com outra sessão (scripts/gate.mjs).' }));
      return 0;
    }
    if (r.status === 0) {
      rmSync(mark, { force: true });
      rmSync(fail, { force: true });
      return 0;
    }
    if (what === 'warn') {
      process.stdout.write(JSON.stringify({ systemMessage: 'npm run check continua vermelho; o turno terminou sem corrigir (scripts/gate.mjs).' }));
      return 0;
    }
    // The errors, then the check's own summary last (the seconds and the step that failed).
    const tail = (text, n) => (text ?? '').trimEnd().split('\n').slice(-n).join('\n');
    reason = `${tail(r.stderr, 40)}\n${tail(r.stdout, 16)}`.trim() || `check ended with ${r.status ?? r.signal}`;
    writeFileSync(fail, JSON.stringify({ fingerprint: fp, reason }));
  }
  process.stderr.write(
    'npm run check is red, so this turn cannot end yet (scripts/gate.mjs). Fix the cause; if it comes from ' +
      "another conversation's work in this folder, tell the player instead of changing it.\n\n" + reason,
  );
  return 2;
}

if (import.meta.main) process.exit(main(process.argv[2]));
