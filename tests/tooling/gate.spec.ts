import { describe, expect, it } from 'vitest';
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
});
