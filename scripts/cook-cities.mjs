// THE CITIES SHIPPED WITH THE GAME (`src/editor/cookedCities.ts`): each size's first city grown here by the game's own generator, prepared as the city's worker prepares it (`cityGen.worker.ts`: `prepareCity`), and written gzipped with the generator's fingerprint (`__CITY_GEN_HASH__`, `scripts/vite/cook-plugin.ts`). Run after a change to the generator: `npm run cook:cities`.
import { createServer } from 'vite';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { COOKED_CITY_SEEDS, COOKED_CITIES_DIR } = await server.ssrLoadModule('/src/editor/cookedCities.ts');
  const { buildLargeCityMap, buildSmallCityMap } = await server.ssrLoadModule('/src/editor/smallCityMap.ts');
  const { prepareCity } = await server.ssrLoadModule('/src/editor/preparedCity.ts');
  const { tableBytes } = await server.ssrLoadModule('/src/world/buildings/recordTable.ts');
  const { cityGenHash } = await server.ssrLoadModule('/scripts/vite/cook-plugin.ts');
  const hash = cityGenHash(root);
  const dir = join(root, 'cooked', COOKED_CITIES_DIR);
  mkdirSync(dir, { recursive: true });
  const cities = {};
  for (const [kind, seed] of Object.entries(COOKED_CITY_SEEDS)) {
    const started = Date.now();
    const made = prepareCity(kind === 'large' ? buildLargeCityMap(seed) : buildSmallCityMap(seed));
    const data = `${kind}-${seed}.json.gz`, table = `${kind}-${seed}.table.gz`;
    writeFileSync(join(dir, data), gzipSync(JSON.stringify(made.data), { level: 9 }));
    writeFileSync(join(dir, table), gzipSync(new Uint8Array(tableBytes(made.buildings)), { level: 9 }));
    cities[kind] = { seed, data, table };
    console.log(`${kind} city of seed ${seed}: grown and prepared in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hash, cities }, null, 2));
  console.log(`cooked/${COOKED_CITIES_DIR} written for the generator ${hash}`);
} finally {
  await server.close();
}
