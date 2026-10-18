import { type UserConfig, defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

/** THE DESKTOP'S JOB THREADS BUILT FOR NODE (`desktop/jobs.cjs`, `src/jobs/nodeJobHost.ts`): the game's own job worker, every module it loads bundled in (no node_modules beside the game), next to the page's build (`dist/desktop-jobs/`, served nowhere: read by the job processes) */
export default mergeConfig(base as UserConfig, defineConfig({
  build: {
    ssr: 'src/jobs/nodeJobHost.ts',
    outDir: 'dist/desktop-jobs',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'jobHost.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
}));
