import { defineConfig } from 'vitest/config';
import base, { SLOW_SPECS } from './vitest.config';

/**
 * The slow specs (`tests/slow.json`), on their own and never before a push:
 * `npm run test:slow`. Each is to be rewritten to run in seconds and leave the
 * list (docs/research/regression-barrier.md).
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [...SLOW_SPECS],
    // The counting suites in the list (`tests/perf`, `tests/scale`) run here too.
    exclude: (base.test?.exclude ?? []).filter((pattern) => !SLOW_SPECS.includes(pattern) && pattern !== 'tests/perf/**' && pattern !== 'tests/scale/**'),
    testTimeout: 900_000,
  },
});
