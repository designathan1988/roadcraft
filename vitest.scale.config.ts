import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** The counting suites: the work of a tick and of an edit on a small map and a large one (`tests/perf`, `tests/scale`). */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/perf/**/*.spec.ts', 'tests/scale/**/*.spec.ts'],
    exclude: (base.test?.exclude ?? []).filter((pattern) => pattern !== 'tests/perf/**' && pattern !== 'tests/scale/**'),
    fileParallelism: false,
    maxWorkers: 1,
  },
});
