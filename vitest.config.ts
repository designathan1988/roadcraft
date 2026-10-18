import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { cpus } from 'node:os';
import { modelUrlsPlugin } from './scripts/vite/model-urls-plugin.ts';
import { joinSessionJob, share } from './scripts/sessionJob.mjs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Every run of the specs inside the conversation's share of the machine
if (process.env['ROADCRAFT_IN_JOB'] !== '1') {
  const joined = joinSessionJob();
  if (joined.joined) process.env['ROADCRAFT_IN_JOB'] = '1';
  else if (process.platform === 'win32') console.error(`vitest: not in the conversation's job (${joined.why})`);
}
/** As many workers as the share has processors (6 of 24 at 25 %). */
const SHARE_WORKERS = Math.max(1, Math.floor((cpus().length * share().percent) / 100));


export default defineConfig({
  // The model files' URLs (`model-urls-plugin.ts`), as the game imports them.
  plugins: [modelUrlsPlugin()],
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@world': r('./src/world'),
      '@sim': r('./src/sim'),
      '@render': r('./src/render'),
      '@view': r('./src/view'),
      '@editor': r('./src/editor'),
      '@ui': r('./src/ui'),
      '@people': r('./src/people'),
      '@': r('./src'),
    },
  },
  test: {
    globals: true,
    // Headless by design: no DOM. Anything needing a canvas uses the FakeCtx recorder.
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Scratch space for investigation, ignored by the runner, the linter and the compiler alike.
    exclude: ['tests/e2e/**', 'tests/perf/**', 'tests/scale/**', 'tests/**/_*/**', 'tests/**/_*', 'tests/**/zz*/**', 'tests/**/zz*'],
    // Tests always run with invariant assertions armed.
    env: { SIM_STRICT: '1' },
    // A test that needs more than 10 s does not belong in the check
    testTimeout: 10_000,
    // What the specs read by path rather than import
    forceRerunTriggers: [
      '**/package.json', '**/vitest.config.*', '**/vite.config.*',
      '**/lots/**', '**/public/**', '**/index.html', '**/tests/fixtures/**', '**/tests/fuzz/fixtures/**',
      '**/src/**/*.json',
    ],
    // A CAP on the workers, not the default of one per hardware thread.
    maxWorkers: Math.min(SHARE_WORKERS, Number(process.env.VITEST_MAX_WORKERS ?? SHARE_WORKERS)),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // The layers that can be tested headlessly and deterministically
      include: [
        'src/core/**/*.ts',
        'src/world/**/*.ts',
        'src/sim/**/*.ts',
        'src/editor/**/*.ts',
        'src/render/mesh/**/*.ts',
        'src/ui/i18n/**/*.ts',
      ],
      // Set from the measured value, so they can only ever be raised.
      thresholds: {
        statements: 66,
        branches: 54,
        functions: 70,
        lines: 69,
      },
    },
  },
});
