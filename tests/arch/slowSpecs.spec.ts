import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No slow process, no endless test (the player, 2026-10-13). The specs that
 * took 10 s or more are listed in `tests/slow.json`, run only by
 * `npm run test:slow`, and are rewritten until the list is empty
 * (docs/research/regression-barrier.md). The 10 s cap of every other test:
 * `tests/arch/testRules.spec.ts`.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const slow = Object.keys((JSON.parse(readFileSync(join(root, 'tests', 'slow.json'), 'utf8')) as { files: Record<string, number> }).files);
/** The length of the list when it was made (2026-10-13). Lowered as specs leave it; never raised. */
const SLOW_AT_MOST = 44;

describe('the slow specs', () => {
  it('only ever shrink, and each one listed exists', () => {
    expect(slow.length).toBeLessThanOrEqual(SLOW_AT_MOST);
    for (const file of slow) expect(existsSync(join(root, file)), file).toBe(true);
  });
});
