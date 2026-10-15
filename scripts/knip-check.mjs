// Knip with a baseline that can only shrink.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE = 'scripts/baselines/knip.baseline.json';
const run = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--reporter', 'json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (!run.stdout.trim().startsWith('{')) {
  console.error('knip did not run:', run.stderr.slice(0, 2000));
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
    console.error(`knip: ${issues.length} problems, more than the baseline's ${baseline.length}; the baseline only shrinks.`);
    process.exit(1);
  }
  mkdirSync('scripts/baselines', { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(issues, null, 1) + '\n');
  console.log(`knip: baseline with ${issues.length} entries`);
  process.exit(0);
}
const known = new Set(baseline);
const now = new Set(issues);
const added = issues.filter((i) => !known.has(i));
const gone = baseline.filter((i) => !now.has(i));
if (added.length) console.error(`knip: ${added.length} new (unused):\n${added.join('\n')}`);
if (gone.length) console.error(`knip: ${gone.length} baseline entries already fixed; take them out (node scripts/knip-check.mjs --update):\n${gone.join('\n')}`);
// The baseline is the list of known defects to fix, not an acceptance. DO NOT word this as a pass.
if (!added.length && !gone.length) console.log(`knip: nothing new; ${baseline.length} known defects still in the code (baseline, to fix)`);
process.exit(added.length || gone.length ? 1 : 0);
