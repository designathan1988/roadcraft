import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { buildStampPlugin } from './scripts/vite/build-stamp.ts';
import { cookPlugin } from './scripts/vite/cook-plugin.ts';
import { labReportsPlugin } from './scripts/vite/labReports.ts';
import { labSourcePlugin } from './scripts/vite/labSource.ts';
import { modelUrlsPlugin } from './scripts/vite/model-urls-plugin.ts';
import { surfaceBakePlugin } from './scripts/vite/surface-bake-plugin.ts';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// The page cross-origin isolated: the same headers the desktop's `app://` sends (`desktop/isolation.cjs`; Vite replaces `import.meta.url` in its config with the file's own).
const ISOLATED = createRequire(import.meta.url)('./desktop/isolation.cjs') as Record<string, string>;

/** The map's tiles each way (`wholeMap.ts` MAP_TILES): 10 unless a run asks a larger map to prove the scale (ROADCRAFT_MAP_TILES, even, 2-64). */
const MAP_TILES = Number(process.env['ROADCRAFT_MAP_TILES'] ?? 10);
if (!Number.isInteger(MAP_TILES) || MAP_TILES < 2 || MAP_TILES > 64 || MAP_TILES % 2 !== 0) throw new Error(`ROADCRAFT_MAP_TILES must be an even number of tiles from 2 to 64, not ${process.env['ROADCRAFT_MAP_TILES']}`);

export default defineConfig({
  root: '.',
  // The map's size and a weaker machine played on this one (`core/weakMachine.ts`), the page and every worker the same.
  define: { __MAP_TILES__: String(MAP_TILES), __WEAK_MACHINE__: JSON.stringify(process.env['ROADCRAFT_WEAK'] ?? '') },
  // `modelUrlsPlugin`: the model files' URLs, a module per folder, never inlined (`model-urls-plugin.ts`).
  // `surfaceBakePlugin`: the procedural surfaces baked at build time into KTX2 (`surface-bake-plugin.ts`); before `cookPlugin`, whose middleware serves them once baked.
  // `labReportsPlugin`: the lab recorder's reports written into `lab-reports/` (dev server only, `labReports.ts`).
  // `labSourcePlugin`: the lab inspector's search of where a 3D object's name is made in `src/` (dev server only, `labSource.ts`).
  plugins: [buildStampPlugin(), surfaceBakePlugin(), cookPlugin(), modelUrlsPlugin(), labReportsPlugin(), labSourcePlugin()],
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
  // The workers' own bundles take the model URLs too (Vite `worker.plugins`): the people's worker reads the proxies (`people/body/proxy.ts`).
  worker: { format: 'es', plugins: () => [modelUrlsPlugin()] },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    // three.js is most of the bundle and never changes between releases of the game, so it gets its own chunk
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Its WebGPU renderer and node materials in a chunk of their own, loaded only with `?gpu=webgpu` or a comparison (`render/gpu/webgpuView.ts`): the WebGL game never downloads them.
        manualChunks: (id: string) =>
          /node_modules\/three\/build\/three\.(webgpu|tsl)/.test(id) ? 'three-webgpu' : id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
});
