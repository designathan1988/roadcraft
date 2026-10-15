import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { buildStampPlugin } from './scripts/vite/build-stamp';
import { cookPlugin } from './scripts/vite/cook-plugin';
import { modelUrlsPlugin } from './scripts/vite/model-urls-plugin';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// The page cross-origin isolated (MDN, crossOriginIsolated): what SharedArrayBuffer needs, for the simulation's worker.
const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  root: '.',
  // `modelUrlsPlugin`: the model files' URLs, a module per folder, never inlined (`model-urls-plugin.ts`).
  plugins: [buildStampPlugin(), cookPlugin(), modelUrlsPlugin()],
  publicDir: false,
  // The dependencies are found from the game's own pages only.
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
    port: Number(process.env['PORT'] ?? 5300),
    strictPort: true,
    // Lets the page sample its own JavaScript (`new Profiler`), to find what a frame spends its time on in the running game.
    headers: { 'Document-Policy': 'js-profiling', ...ISOLATED },
    // Test and coverage artefacts live under the project root.
    watch: {
      ignored: [
        '**/coverage/**',
        '**/dist/**',
        '**/playwright-report/**',
        '**/test-results/**',
        // Parallel agent worktrees live inside the project folder; an edit there must not reload the game being inspected here.
        '**/.claude/**',
      ],
    },
  },
  preview: { headers: ISOLATED },
  // ES workers: the simulation's worker makes workers of its own and imports its walkers when it starts (Vite, worker.format).
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    // three.js is most of the bundle and never changes between releases of the game, so it gets its own chunk
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
});
