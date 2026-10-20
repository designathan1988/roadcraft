import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** PostToolUse: a change to the game's own code (src/) is not done until the game has been photographed and the photos looked at (the stop hook `.claude/hooks/require-photos.mjs`). */

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch { /* no input: no change said */ }
const project = resolve(process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd());
const said = event?.tool_input?.file_path ?? event?.tool_input?.path ?? '';
if (typeof said !== 'string' || !said) process.exit(0);
const file = isAbsolute(said) ? said : resolve(event?.cwd ?? project, said);
const inside = relative(join(project, 'src'), file);
if (inside.startsWith('..') || isAbsolute(inside)) process.exit(0);
const marker = join(project, '.claude', 'verify-needed.json');
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), file: relative(project, file) }));
