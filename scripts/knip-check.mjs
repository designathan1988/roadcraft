// Knip with a baseline that can only shrink (docs/research/protections.md).
// Knip has no suppression file: the unused exports, types and enum members the
// SOURCE brought are listed in `knip.baseline.json`. The check fails on any
// issue not in it (something new left unused) and on any entry no longer
// reported (fixed: take it out). `--update` writes the baseline (only when
// the count falls, by the rule of CLAUDE.md).
// node scripts/knip-check.mjs [--update]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE = 'knip.baseline.json';
const run = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--reporter', 'json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (!run.stdout.trim().startsWith('{')) {
  console.error('knip não rodou:', run.stderr.slice(0, 2000));
  process.exit(2);
}
const issues = [];
for (const issue of JSON.parse(run.stdout).issues) {
  for (const [type, list] of Object.entries(issue)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) issues.push(`${type} ${issue.file} ${item.name ?? ''}`.trim());
  }
}
issues.sort();
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [];
if (process.argv.includes('--update')) {
  if (issues.length > baseline.length && baseline.length > 0) {
    console.error(`knip: ${issues.length} problemas, mais que os ${baseline.length} da linha de base; a linha de base só diminui.`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(issues, null, 1) + '\n');
  console.log(`knip: linha de base com ${issues.length} itens`);
  process.exit(0);
}
const known = new Set(baseline);
const now = new Set(issues);
const added = issues.filter((i) => !known.has(i));
const gone = baseline.filter((i) => !now.has(i));
if (added.length) console.error(`knip: ${added.length} novos (sem uso):\n${added.join('\n')}`);
if (gone.length) console.error(`knip: ${gone.length} itens da linha de base já resolvidos; tire-os (node scripts/knip-check.mjs --update):\n${gone.join('\n')}`);
if (!added.length && !gone.length) console.log(`knip: nada novo; linha de base ${baseline.length}`);
process.exit(added.length || gone.length ? 1 : 0);
