import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * THE TOOLS THAT HOLD THE CHECK: the decision of the end-of-turn gate (`scripts/gate.mjs`, run by the
 * hooks of `.claude/settings.json`) and the steps the check picks for a change (`scripts/check.mjs`).
 */
const ROOT = join(__dirname, '..', '..');
const load = (f: string): Promise<Record<string, (...args: never[]) => unknown>> =>
  import(pathToFileURL(join(ROOT, 'scripts', f)).href) as Promise<Record<string, (...args: never[]) => unknown>>;

describe('the end-of-turn gate', () => {
  it('runs the check only for a conversation that changed code, and never loops on the same red state', async () => {
    const { decide } = (await load('gate.mjs')) as { decide: (s: object) => string };
    const failed = { fingerprint: 'a', reason: 'red' };
    expect(decide({ touched: false, fingerprint: '', failed: null, active: false })).toBe('skip');
    expect(decide({ touched: true, fingerprint: 'a', failed: null, active: false })).toBe('run');
    expect(decide({ touched: true, fingerprint: 'b', failed, active: false })).toBe('run');
    expect(decide({ touched: true, fingerprint: 'a', failed, active: false })).toBe('block');
    // Continued by this hook and still red: once more, then the turn ends (another conversation's edits
    // change the files between stops, so "the same files" is not what ends it).
    expect(decide({ touched: true, fingerprint: 'a', failed, active: true })).toBe('warn');
    expect(decide({ touched: true, fingerprint: 'b', failed, active: true })).toBe('warn');
  });

  it('counts code, tests and settings, not docs, notes or files outside the project', async () => {
    const { counts } = (await load('gate.mjs')) as { counts: (file: string, root: string) => boolean };
    expect(counts(join(ROOT, 'src/sim/pipeline.ts'), ROOT)).toBe(true);
    expect(counts(join(ROOT, 'tests/sim/traffic.spec.ts'), ROOT)).toBe(true);
    expect(counts(join(ROOT, 'scripts/check.mjs'), ROOT)).toBe(true);
    expect(counts(join(ROOT, '.claude/settings.json'), ROOT)).toBe(true);
    expect(counts(join(ROOT, 'docs/PLAN.md'), ROOT)).toBe(false);
    expect(counts(join(ROOT, 'CLAUDE.md'), ROOT)).toBe(false);
    expect(counts(join(tmpdir(), 'x.ts'), ROOT)).toBe(false);
  });
});

describe('the specs of the check', () => {
  it('always runs those that read the code or the page as text, which no import leads to', async () => {
    const { ALWAYS } = (await import(pathToFileURL(join(ROOT, 'scripts', 'check.mjs')).href)) as { ALWAYS: string[] };
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.spec.ts') ? [`${dir}/${e.name}`] : []);
    const reading = walk('tests').filter((f) =>
      /(readFileSync|readdirSync)\([^)]*(SRC|root|index\.html|src\/[^'"`]*\.ts)/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(reading.length).toBeGreaterThan(5);
    expect(reading.filter((f) => !ALWAYS.some((a) => f.startsWith(a)))).toEqual([]);
  });

  it('are those a change reaches, plus the always-run ones; every spec for a full check', async () => {
    const { specsFor, ALWAYS } = (await import(pathToFileURL(join(ROOT, 'scripts', 'check.mjs')).href)) as
      { specsFor: (files: string[] | null) => string[] | null; ALWAYS: string[] };
    expect(specsFor(null)).toBeNull();
    const specs = specsFor(['src/sim/pipeline.ts', 'docs/PLAN.md', 'src/gone.ts'])!;
    expect(specs[0]).toBe('src/sim/pipeline.ts');
    expect(specs).toContain('tests/arch/testRules.spec.ts');
    expect(specs).toContain('tests/ui/oldInterface.spec.ts');
    expect(specs.filter((f) => !f.endsWith('.spec.ts'))).toEqual(['src/sim/pipeline.ts']);
    expect(ALWAYS.length).toBeGreaterThan(0);
  });
});

describe('the steps of the check', () => {
  it('runs nothing for docs, everything but the build for tests, and everything for the rest', async () => {
    const { stepsFor } = (await load('check.mjs')) as { stepsFor: (files: string[] | null) => string[] };
    const all = ['lint', 'code', 'knip', 'unit', 'scale', 'build'];
    expect(stepsFor(['docs/PLAN.md', 'CLAUDE.md'])).toEqual([]);
    expect(stepsFor([])).toEqual([]);
    expect(stepsFor(['tests/sim/traffic.spec.ts', 'docs/STATUS.md'])).toEqual(all.filter((s) => s !== 'build'));
    expect(stepsFor(['src/sim/pipeline.ts'])).toEqual(all);
    expect(stepsFor(['package.json'])).toEqual(all);
    expect(stepsFor(null)).toEqual(all);
  });

  it("keeps the turn's check to the barrier: lint and code rules; the tests run at the end of a block", async () => {
    const { stepsFor, directSpecsFor } = (await load('check.mjs')) as {
      stepsFor: (files: string[] | null, fast?: boolean) => string[];
      directSpecsFor: (files: string[]) => string[];
    };
    expect(stepsFor(['src/sim/pipeline.ts'], true)).toEqual(['lint', 'code']);
    expect(stepsFor(['docs/PLAN.md'], true)).toEqual([]);
    // A file the whole game imports: the specs of its own area that import it, not every spec it reaches.
    const doc = directSpecsFor(['src/world/doc.ts']).filter((s) => !s.startsWith('tests/arch/') && !s.startsWith('tests/tooling/'));
    expect(doc.length).toBeGreaterThan(10);
    expect(doc.filter((s) => s.startsWith('tests/') && !s.startsWith('tests/world/') && !s.startsWith('tests/ui/') && !s.startsWith('tests/render/'))).toEqual([]);
    // A changed spec runs itself.
    expect(directSpecsFor(['tests/sim/traffic.spec.ts'])).toContain('tests/sim/traffic.spec.ts');
  });
});
