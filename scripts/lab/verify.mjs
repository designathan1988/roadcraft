// THE LAB'S SELF-CHECK: every feature of the debugging lab (F7) exercised in the running game, each with a verdict and its evidence.
// `node scripts/lab/verify.mjs` (the dev server running): opens the test city headless (`scripts/look.mjs`), runs `scripts/lab/verify/step*.js`, prints the table.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = resolve('scripts/lab/verify');
const out = mkdtempSync(join(tmpdir(), 'lab-verify-'));
const plan = {
  city: true,
  steps: [
    { lookAt: [0, 0, 2.5] }, { wait: 3000 },
    { evalFile: join(here, 'common.js') }, { key: 'F7' }, { wait: 1500 },
    { evalFile: join(here, 'step1.js') },
    { evalFile: join(here, 'step2.js') },
    { evalFile: join(here, 'step3.js') },
    { evalFile: join(here, 'step4.js') },
    { evalFile: join(here, 'step5.js') },
  ],
};
const planFile = join(out, 'plan.json');
writeFileSync(planFile, JSON.stringify(plan));
try {
  execFileSync(process.execPath, ['scripts/look.mjs', planFile, out], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch (error) {
  console.error('look.mjs failed', error.message);
}
const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
const last = [...report.steps].reverse().find((s) => typeof s.value === 'string' && s.value.startsWith('[{'));
const results = last ? JSON.parse(last.value) : [];
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} — ${r.evidence}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} work; ${failed} fail. Game console: ${(report.console || []).length} warnings/errors.`);
for (const c of (report.console || []).slice(0, 10)) console.log(`  console: ${String(c).slice(0, 200)}`);
process.exitCode = failed ? 1 : 0;
