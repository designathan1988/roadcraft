import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No slow process, no endless test (the player, 2026-10-13). The check and
 * the push run only specs that finish in seconds; the specs that took 10 s or
 * more are listed in `tests/slow.json`, run only by `npm run test:slow`, and
 * are rewritten until the list is empty (docs/research/regression-barrier.md).
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const slow = Object.keys((JSON.parse(readFileSync(join(root, 'tests', 'slow.json'), 'utf8')) as { files: Record<string, number> }).files);
/** The length of the list when it was made (2026-10-13). Lowered as specs leave it; never raised. */
const SLOW_AT_MOST = 45;
/** The longest a test of the check may declare for itself, ms (`vitest.config.ts` testTimeout). */
const CAP_MS = 10_000;

const specs = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? specs(join(dir, e.name)) : e.name.endsWith('.spec.ts') ? [join(dir, e.name).split(sep).join('/')] : []);

describe('the slow specs', () => {
  it('only ever shrink, and each one listed exists', () => {
    expect(slow.length).toBeLessThanOrEqual(SLOW_AT_MOST);
    for (const file of slow) expect(existsSync(join(root, file)), file).toBe(true);
  });

  it('are the only specs that may give a test more than 10 s', () => {
    const over: string[] = [];
    for (const file of specs('tests')) {
      if (slow.includes(file)) continue;
      readFileSync(join(root, file), 'utf8').split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        // A test or a hook closed with `}, 120_000);`, or `{ timeout: 120_000 }`.
        for (const m of line.matchAll(/(?:^\s*\}\s*,\s*|timeout\s*:\s*)(\d[\d_]*)/g)) {
          if (Number(m[1]!.replace(/_/g, '')) > CAP_MS) over.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(over).toEqual([]);
  });
});
