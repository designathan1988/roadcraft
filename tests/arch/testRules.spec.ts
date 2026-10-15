import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** THE RULES OF THE TESTS (read from the files: nothing runs). */
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
    const over: string[] = [];
    for (const [file, src] of SOURCE) {
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
