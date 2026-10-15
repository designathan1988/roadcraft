import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { cpus } from 'node:os';
import { modelUrlsPlugin } from './scripts/vite/model-urls-plugin';
import { joinSessionJob, share } from './scripts/sessionJob.mjs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Every run of the specs inside the conversation's share of the machine (`scripts/sessionJob.mjs`), also a
// bare `npx vitest` an agent starts: its workers are this process's children, in the same job.
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
    // Scratch space for investigation, ignored by the runner, the linter and
    // the compiler alike. The pattern used to be `tests/_*/**`, which only
    // matches a folder at the TOP of `tests/` - a probe dropped beside the
    // tests it was probing, `tests/world/_diag.spec.ts`, ran and could break
    // `npm run check`, which is exactly what the invariant promised it could
    // not. Any path segment starting with an underscore is scratch now, and so
    // is the `zz` prefix this working tree already uses for the same kind of
    // one-off harness (`tests/render/zzCrowdGaitCompare.spec.ts` and friends).
    // The counting suites (`tests/perf`, `tests/scale`) run on their own, one
    // file at a time (`vitest.scale.config.ts`): they build whole grids of
    // traffic, and beside the rest of the suite they ran out of time on CPU
    // contention, not on a defect.
    exclude: ['tests/e2e/**', 'tests/perf/**', 'tests/scale/**', 'tests/**/_*/**', 'tests/**/_*', 'tests/**/zz*/**', 'tests/**/zz*'],
    // Tests always run with invariant assertions armed.
    env: { SIM_STRICT: '1' },
    // A test that needs more than 10 s does not belong in the check (the
    // player, 2026-10-13: no slow processes, no endless tests): it fails here,
    // and is made to run in seconds, never moved to the slow list.
    testTimeout: 10_000,
    // What the specs read by path rather than import: a change to it runs every spec, even when the check
    // picks the specs by their imports (`scripts/check.mjs`, `vitest related`). Vitest's own three first.
    forceRerunTriggers: [
      '**/package.json', '**/vitest.config.*', '**/vite.config.*',
      '**/lots/**', '**/public/**', '**/index.html', '**/tests/fixtures/**', '**/tests/fuzz/fixtures/**',
      '**/src/**/*.json',
    ],
    // A CAP on the workers, not the default of one per hardware thread. Each
    // worker can be simulating a whole map; on a 24-thread machine the default
    // started 23 of them per run, and a few runs side by side froze the
    // computer the game is played on. At most the conversation's share (VITEST_MAX_WORKERS asks for fewer).
    maxWorkers: Math.min(SHARE_WORKERS, Number(process.env.VITEST_MAX_WORKERS ?? SHARE_WORKERS)),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // The layers that can be tested headlessly and deterministically: the
      // document, the geometry, the height solver, the mesh builder and the
      // simulation. WebGL, the DOM interface and the viewport seam are covered
      // by `npm run verify:visual`, which drives the real application in a real
      // browser; asking a node test runner to cover them would only measure how
      // much of the renderer can be imported without a GPU.
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
