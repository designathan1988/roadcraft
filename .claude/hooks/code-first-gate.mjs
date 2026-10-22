// THE CODE-FIRST GATE (PreToolUse): no run of the game, its photos, its tests, a build or a browser until the cause was found in the code
// (`.claude/diagnosis.md` with a real `src/<file>:<line>` root cause) and the code was changed after it; one verification per code change.
// See `.claude/skills/code-first/SKILL.md`. Exit code 2 blocks the tool call and shows the reason to the model.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DIAG = join(root, '.claude', 'diagnosis.md');
const STATE = join(root, '.claude', 'code-first-state.json');

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input: nothing to judge */ }
const tool = String(input.tool_name || '');
const command = String(input.tool_input?.command || '');

const BROWSER_TOOL = /^mcp__(chrome-devtools|threejs-devtools-mcp|claude-in-chrome|Claude_Browser)__/;
const RUN = /look\.mjs|look-compare|verify\.mjs|vitest|playwright|vite\s+build|vite\.js|npx\s+vite|npm\s+(run\s+)?(test|verify|look|build|cook|budgets|dev)|ssrLoadModule|createServer|chrome\.exe|electron|--remote-debugging|cook-cities|measureCity|bisect/i;
const gated = BROWSER_TOOL.test(tool) || ((tool === 'Bash' || tool === 'PowerShell') && RUN.test(command));
if (!gated) process.exit(0);

const block = (why) => {
  process.stderr.write(`CODE-FIRST GATE: ${why}\nRead and trace the code (Read/Grep), write .claude/diagnosis.md (Symptom, Trace, Root cause, Fix with src/<file>.ts:<line>), fix src/, then ONE verification. Skill: .claude/skills/code-first/SKILL.md\n`);
  process.exit(2);
};

if (!existsSync(DIAG)) block('no diagnosis written.');
const diag = readFileSync(DIAG, 'utf8');
for (const section of ['Symptom:', 'Trace:', 'Root cause:', 'Fix:']) if (!diag.includes(section)) block(`the diagnosis has no "${section}" section.`);
const GUESS = /\b(maybe|probably|likely|perhaps|suspect\w*|hypothes\w*|guess\w*|might|could be|talvez|provavelmente|possivelmente|suspeit\w*|hip[oó]tese\w*|acho que|parece que)\b/i;
const guess = diag.match(GUESS);
if (guess) block(`the diagnosis guesses ("${guess[0]}"): read more code until it is certain.`);

// Every src/<file>:<line> cited must exist; the trace needs at least 3, the root cause at least 1.
const refs = [...diag.matchAll(/\b(src\/[\w./-]+\.(?:ts|tsx|js|mjs|glsl)):(\d+)/g)];
const section = (name) => { const at = diag.indexOf(name); if (at < 0) return ''; const rest = diag.slice(at + name.length); const next = rest.search(/\n(Symptom|Trace|Root cause|Fix):/); return next < 0 ? rest : rest.slice(0, next); };
const countIn = (text) => [...text.matchAll(/\bsrc\/[\w./-]+\.(?:ts|tsx|js|mjs|glsl):\d+/g)].length;
if (countIn(section('Trace:')) < 3) block('the trace cites fewer than 3 src/<file>:<line> steps.');
if (countIn(section('Root cause:')) < 1) block('the root cause cites no src/<file>:<line>.');
for (const [, file, line] of refs) {
  const at = join(root, file);
  if (!existsSync(at)) block(`the diagnosis cites ${file}, which does not exist.`);
  const lines = readFileSync(at, 'utf8').split('\n').length;
  if (Number(line) < 1 || Number(line) > lines) block(`the diagnosis cites ${file}:${line}, past its ${lines} lines.`);
}

// The code changed after the diagnosis, and since the last verification.
const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };
const changed = [...new Set([...git(['diff', '--name-only', 'HEAD', '--', 'src']).split('\n'), ...git(['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n')])].filter(Boolean);
const diagTime = statSync(DIAG).mtimeMs;
const newer = changed.filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).mtimeMs > diagTime);
if (newer.length === 0) block('no file of src/ was changed after the diagnosis: fix the code before running anything.');
const fingerprint = createHash('sha1').update(git(['diff', 'HEAD', '--', 'src'])).update(newer.map((f) => `${f}:${statSync(join(root, f)).mtimeMs}`).join('|')).digest('hex');
let state = {};
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* first verification */ }
if (state.fingerprint === fingerprint && (state.runs ?? 0) >= 2) block('this code was already verified: a second run of the same code is trial and error. Read the code again and change it.');
writeFileSync(STATE, JSON.stringify({ fingerprint, runs: state.fingerprint === fingerprint ? (state.runs ?? 0) + 1 : 1, at: new Date().toISOString() }));
process.exit(0);
