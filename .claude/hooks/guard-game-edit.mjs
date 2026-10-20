import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * PreToolUse for Edit/Write/MultiEdit: while the last src/ change has no fresh photos and written
 * analysis, the next src/ edit is refused. The stop hook alone only acts at the end of a turn; this
 * one acts on the next change, so every change is photographed and looked at before another is made.
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch { /* no input */ }
const project = resolve(process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd());
const said = event?.tool_input?.file_path ?? event?.tool_input?.path ?? '';
if (typeof said !== 'string' || !said) process.exit(0);
const file = isAbsolute(said) ? said : resolve(event?.cwd ?? project, said);
const inside = relative(join(project, 'src'), file);
if (inside.startsWith('..') || isAbsolute(inside)) process.exit(0);
const marker = join(project, '.claude', 'verify-needed.json');
if (!existsSync(marker)) process.exit(0);
// One change set may touch the same file in a few hunks: the verification is owed once the change is whole, not between its hunks.
try {
  const waiting = JSON.parse(readFileSync(marker, 'utf8'));
  const age = Date.now() - Date.parse(waiting.at);
  if (waiting.file === relative(project, file) && age >= 0 && age < 120_000) process.exit(0);
} catch { /* an unreadable marker: the check below refuses */ }

let answer = '';
try {
  answer = execFileSync('node', [join(project, '.claude', 'hooks', 'require-photos.mjs')], { encoding: 'utf8', cwd: project });
} catch { /* the checker failed: refused below, saying why */ }
// The checker clears the marker only when the photos, the report and the analysis are all newer than the change.
if (!existsSync(marker)) process.exit(0);
let reason = 'The last game change has no fresh photos and analysis. Take the 24-view matrix (node scripts/look.mjs scripts/look/views.json <folder>), open every PNG, write lab-reports/last-analysis.md and only then edit src/ again.';
try {
  const said = JSON.parse(answer.trim());
  if (said?.decision === 'block' && said.reason) reason = said.reason;
} catch { /* the generic reason stands */ }
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse',
  permissionDecision: 'deny',
  permissionDecisionReason: reason,
} }));
