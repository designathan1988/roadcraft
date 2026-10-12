import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import noSilentCatch from './eslint-rules/no-silent-catch.js';
import noModuleState from './eslint-rules/no-module-state.js';

/**
 * The repository's own rules (`eslint-rules/`). What the SOURCE carried that
 * breaks them is held in `eslint-suppressions.json` (ESLint's bulk
 * suppressions): ESLint fails on any NEW violation, and on a suppression no
 * longer needed, so the count can only fall; it reaches zero by stage F4
 * (docs/PLAN.md).
 */
const roadcraft = { rules: { 'no-silent-catch': noSilentCatch, 'no-module-state': noModuleState } };

/**
 * THE LAYER ORDER, ENFORCED.
 *
 * CLAUDE.md (Layers) states the dependency order and says never to violate
 * it. Nothing checked, and two violations had grown:
 *
 *   - `world/markings.ts` imported its line colours from `ui/overlay/palette`,
 *     a real cycle - `world` to `ui` and `ui` back to `world`;
 *   - `render` reached `ui` through `view`, because the flat camera sat in
 *     `ui/overlay/` while `view/viewport.ts` imported it.
 *
 * Both are fixed. This is what stops them coming back, and what makes the
 * order a rule rather than a paragraph.
 *
 * Each entry lists the layers that one may import, ITSELF INCLUDED. `main.ts`
 * is the composition root and is deliberately absent: wiring every layer
 * together is its whole job.
 *
 * `ui` may read `sim` because the inspector and the minimap display live
 * simulation state. It is a read of a layer below it, not a cycle: nothing in
 * `sim` knows `ui` exists.
 */
const LAYERS = {
  core: ['core'],
  world: ['core', 'world'],
  sim: ['core', 'world', 'sim'],
  view: ['core', 'view'],
  render: ['core', 'world', 'sim', 'view', 'render'],
  editor: ['core', 'world', 'editor'],
  ui: ['core', 'world', 'sim', 'view', 'ui'],
};

const ALL = Object.keys(LAYERS);

/** One ESLint block per layer, banning every alias it may not import. */
const layerRules = Object.entries(LAYERS).map(([layer, allowed]) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: ALL.filter((other) => !allowed.includes(other)).map((other) => ({
          group: [`@${other}/*`, `@/${other}/*`],
          message:
            `${layer} may not import ${other}. See the dependency order in ` +
            'CLAUDE.md (Layers) - if the thing you want is in the wrong ' +
            'layer, move the thing rather than the import.',
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'docs/screenshots/**',
      // Dropped-in assets and generated output. Both are git-ignored, and a
      // vendor's own verification script is not this repository's code.
      'incoming/**',
      'exports/**',
      'cooked/**',
      // The desktop build (`npm run desktop:pack`): Electron and the game,
      // compiled and packed - output, not this repository's source.
      'release/**',
      // Systems taken out of the game, kept for reference only (`src/backup/README.md`).
      'src/backup/**',
      // The labs (FORMA, `labs/building/forma`): projects of their own, with
      // their own package.json, tsconfig and tests, not the game; the root lint
      // was never green over them (127 errors when they came from master).
      'labs/**',
      // Agent worktrees are full checkouts of the repository; they are linted
      // in their own checkout, never from this one.
      '.claude/**',
      // Scratch space for investigation. Never committed, never linted: a
      // throwaway probe must not be able to break `npm run check`. Matched at
      // ANY depth, because a probe is dropped beside what it probes.
      'tests/**/_*/**',
      'tests/**/_*',
      'scripts/**/_*/**',
      'scripts/**/_*',
      // `zz` is this working tree's older scratch prefix for the same kind of
      // file (a probe or one-off harness dropped beside what it measures). The
      // runner's exclude carries the same rule; without it here a `zz` probe
      // breaks `npm run check` exactly as an `_` probe once did.
      '**/zz*.mjs',
      '**/zz*.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...layerRules,
  {
    // One file, one responsibility; none over 800 lines (CLAUDE.md). No error
    // swallowed anywhere; no mutable state loose in a module of the game.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs', '*.ts', '*.js'],
    plugins: { roadcraft },
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }],
      'no-empty': 'error',
      'no-useless-catch': 'error',
      'roadcraft/no-silent-catch': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts'],
    plugins: { roadcraft },
    rules: { 'roadcraft/no-module-state': 'error' },
  },
  {
    // Plain Node tooling. `eslint .` reaches it, and without globals every
    // `console` is an error.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Browser globals inside `page.evaluate` / `addInitScript` callbacks, which
    // ESLint sees as Node code even though they are serialised and run in
    // Chromium. Every one of these scripts drives a real page through
    // Playwright; the callback bodies are browser code by construction.
    files: [
      'scripts/cook-people.mjs',
      'scripts/gate/*.mjs',
    ],
    languageOptions: {
      globals: {
        window: 'readonly',
        Element: 'readonly',
        WebGL2RenderingContext: 'readonly',
        WebGLRenderingContext: 'readonly',
        OffscreenCanvas: 'readonly',
        createImageBitmap: 'readonly',
        btoa: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        PerformanceObserver: 'readonly',
        Profiler: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        Event: 'readonly',
        Image: 'readonly',
      },
    },
  },
  {
    // The desktop window's main process (`desktop/main.cjs`): CommonJS run
    // by Electron's Node, where `require` is how modules load.
    files: ['desktop/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        // Node's fetch API, which Electron's `protocol.handle` answers with.
        Response: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript performs the authoritative project-wide unused check.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // Canvas fakes and browser diagnostic surfaces intentionally model
      // dynamic platform APIs; explicit any is clearer there than casts piled up.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
