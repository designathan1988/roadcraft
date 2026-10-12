import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { buildStampPlugin } from './build-stamp';
import { cookPlugin } from './cook-plugin';
import { modelUrlsPlugin } from './model-urls-plugin';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `--mode planet` builds and serves the planet: six flat maps on a cube, drawn
// as a sphere (`src/core/cubeSphere.ts`). Any other mode is the flat game, and
// every `if (__PLANET__)` branch is dead code there. The world unit is one
// metre; a mode ending in `-old-unit` (`planet-old-unit`, `flat-old-unit`)
// serves it at the 0.4 m unit of before, to compare side by side
// (docs/ESCALA.md).
export default defineConfig(({ mode }) => ({
  root: '.',
  // `modelUrlsPlugin`: the model files' URLs, a module per folder, never
  // inlined (`model-urls-plugin.ts`).
  plugins: [buildStampPlugin(), cookPlugin(), modelUrlsPlugin()],
  // Compile-time keys (declared in `src/globals.d.ts`), replaced by literals in
  // the build so a branch behind `false` is dead code and its imports never
  // reach a chunk.
  define: {
    __PLANET__: JSON.stringify(mode === 'planet' || mode === 'planet-old-unit'),
    // Metres in one world unit (`src/core/units.ts`).
    __METERS_PER_UNIT__: JSON.stringify(mode.endsWith('-old-unit') ? 0.4 : 1),
  },
  publicDir: false,
  // The dependencies are found from the game's own pages only. By default
  // Vite crawls every `.html` under the root (vite.dev/config/
  // dep-optimization-options), and the labs' apps (`labs/building/forma`)
  // import packages installed only in their own folder: the crawl failed,
  // pre-bundling was skipped, and the first load answered 504 and reloaded.
  optimizeDeps: { entries: ['*.html'] },
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
  server: {
    host: '127.0.0.1',
    // 5300, this repository's port (CLAUDE.md "Servers"): the old origins
    // (4180, 5173, 5175-5178, 4181-4183) hold the player's maps, and a game
    // opened there may migrate and rewrite them. Strict: never another port.
    port: Number(process.env['PORT'] ?? 5300),
    strictPort: true,
    // Lets the page sample its own JavaScript (`new Profiler`), to find what
    // a frame spends its time on in the running game.
    headers: { 'Document-Policy': 'js-profiling' },
    // Test and coverage artefacts live under the project root. They must not
    // trigger a full application reload while a browser smoke test is running.
    watch: {
      ignored: [
        '**/coverage/**',
        '**/dist/**',
        '**/playwright-report/**',
        '**/test-results/**',
        // Parallel agent worktrees live inside the project folder; an edit
        // there must not reload the game being inspected here.
        '**/.claude/**',
      ],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    // three.js is most of the bundle and never changes between releases of the
    // game, so it gets its own chunk: a rebuild of the game invalidates ~280 kB
    // rather than ~920 kB of a returning player's cache. The renderer is not
    // lazy-loaded behind a dynamic import, because there is no frame of this
    // game that does not need it — deferring it would only add a round trip
    // before the first paint.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
}));
