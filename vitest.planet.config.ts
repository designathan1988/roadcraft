import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The planet's specs (`tests/planet/`), with `__PLANET__` on as
 * `vite --mode planet` builds it (`vite.config.ts`). `vitest.config.ts` runs
 * every other spec on the flat map and leaves these out.
 * `npx vitest run --config vitest.planet.config.ts`
 */
export default defineConfig({
  ...base,
  define: { ...base.define, __PLANET__: 'true' },
  test: {
    ...base.test,
    include: ['tests/planet/**/*.spec.ts'],
    exclude: (base.test?.exclude ?? []).filter((pattern) => pattern !== 'tests/planet/**'),
  },
});
