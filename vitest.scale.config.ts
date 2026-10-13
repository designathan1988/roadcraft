import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The counting suites: the work of a tick and of an edit on a small map and a
 * large one (`tests/perf`, `tests/scale`). Counts, not timings, so they hold on
 * any machine; run one file at a time, so a whole grid of traffic never shares
 * the CPU with the rest of the suite. `npm run test:scale`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/perf/**/*.spec.ts', 'tests/scale/**/*.spec.ts'],
    // The slow list stays out (`tests/slow.json`).
    exclude: (base.test?.exclude ?? []).filter((pattern) => pattern !== 'tests/perf/**' && pattern !== 'tests/scale/**'),
    fileParallelism: false,
    maxWorkers: 1,
  },
});
