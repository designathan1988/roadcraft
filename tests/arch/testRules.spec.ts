import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE RULES OF THE TESTS (read from the files: nothing runs). A test earns its place by running in every
 * check, the same way on any machine and at any load (Software Engineering at Google, ch. 11: speed and
 * determinism first; "a bad test suite can be worse than no test suite"):
 * - nothing focused (`.only`) and nothing that may not run: no `.skip`, `.todo`, `skipIf` or `runIf` (a
 *   test that runs only with an environment variable or a file of one machine runs nowhere). `it.fails`
 *   stays: a recorded defect that tells when it is fixed (`tests/fuzz/regressions.spec.ts`);
 * - no real clock: no `performance.now()` or `Date.now()` and no wait on a timer, unless the file installs
 *   fake timers (`vi.useFakeTimers`). Wall time is noise: work is counted, never timed
 *   (docs/research/regression-barrier.md);
 * - no test longer than 10 s: none may give itself more than `vitest.config.ts` testTimeout.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const CAP_MS = 10_000;

const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name).split(sep).join('/')] : []);
/** Comments blanked (a word in a note is not code), lines kept where they were; strings stay. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const TESTS = files('tests').filter((f) => !f.split('/').some((part) => part.startsWith('_') || part.startsWith('zz')));
const SOURCE = new Map(TESTS.map((f) => [f, code(readFileSync(join(root, f), 'utf8'))]));
const RULES = 'tests/arch/testRules.spec.ts';

/** `file:line  text` for each line of the test files matching `re` (this file's own patterns aside). */
function find(re: RegExp, keep: (file: string, src: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const [file, src] of SOURCE) {
    if (file === RULES || !keep(file, src)) continue;
    src.split('\n').forEach((line, i) => { if (re.test(line)) out.push(`${file}:${i + 1}  ${line.trim()}`); });
  }
  return out;
}
const realClock = (_file: string, src: string): boolean => !/\bvi\.useFakeTimers\(/.test(src);

describe('the tests', () => {
  it('leave nothing focused', () => {
    expect(find(/\b(?:it|test|describe)\.only\b/)).toEqual([]);
  });

  it('all run, everywhere: nothing skipped, conditional or left to do', () => {
    expect(find(/\b(?:it|test|describe)\.(?:skip|todo|skipIf|runIf)\b|\bctx\.skip\(/)).toEqual([]);
  });

  it('never read the real clock', () => {
    expect(find(/\bperformance\.now\(\)|\bDate\.now\(\)|\bnew Date\(\)/, realClock)).toEqual([]);
  });

  it('never wait on a real timer', () => {
    expect(find(/\bsetTimeout\([^,]+,\s*[1-9]|\bwaitForTimeout\(/, realClock)).toEqual([]);
  });

  it('give no test more than 10 s', () => {
    // The specs still being rewritten (`tests/slow.json`, `tests/arch/slowSpecs.spec.ts`) until the list is empty.
    const slow = Object.keys((JSON.parse(readFileSync(join(root, 'tests', 'slow.json'), 'utf8')) as { files: Record<string, number> }).files);
    const over: string[] = [];
    for (const [file, src] of SOURCE) {
      if (slow.includes(file)) continue;
      src.split('\n').forEach((line, i) => {
        // A test or a hook closed with `}, 120_000);`, or `{ timeout: 120_000 }`.
        for (const m of line.matchAll(/(?:^\s*\}\s*,\s*|timeout\s*:\s*)(\d[\d_]*)/g)) {
          if (Number(m[1]!.replace(/_/g, '')) > CAP_MS) over.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(over).toEqual([]);
  });
});
