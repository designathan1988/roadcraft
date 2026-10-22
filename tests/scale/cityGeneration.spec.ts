import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { buildCityTableOf } from '@editor/smallCityMap';
import type { PreparedCity } from '@editor/preparedCity';
import { RecordTable } from '@world/buildings/recordTable';
import { m } from '@world/units';

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

/** FNV-1a over strings, chained. */
function hashText(text: string, h = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A prepared city as the page reads it: its data's text and every record of its table decoded, one number. */
function cityHash(city: PreparedCity): number {
  let h = hashText(JSON.stringify(city.data));
  const table = new RecordTable(city.buildings), reader = table.reader();
  for (let row = 0; row < table.rows; row++) h = hashText(JSON.stringify(reader.record(row)), h);
  return h;
}

/** The JS heap and the buffers outside it held after a full collection, bytes. */
function live(): number {
  collect(); collect();
  return getHeapStatistics().used_heap_size + process.memoryUsage().arrayBuffers;
}

/**
 * A CITY GROWN OFF THE PAGE WITHOUT HOLDING ITS BUILDINGS AS OBJECTS (`buildCityTable`): the same city the page always opened, and the
 * worker's memory bounded. The city of 160,000 buildings took the generator to 5.6 GB when every building was an object and the whole
 * city was prepared after (2026-10-22), past the 4 GB V8 cage a worker shares with its page.
 */
describe('a city generated off the page', () => {
  // The city of ~25,000 buildings: its data and decoded records hashed as the page reads them, the number taken on the generator before the buildings were spilled to tables (the old `prepareCity(buildLargeCityMap(7, m(2800)))`, 2026-10-22).
  it('makes the city of 25,000 buildings exactly as before', () => {
    const city = buildCityTableOf('large', 7, m(2_800));
    expect({ buildings: new RecordTable(city.buildings).rows, hash: cityHash(city) }).toEqual({ buildings: 25_086, hash: 1_179_907_917 });
  }, 600_000);

  // The city of ~70,000 buildings: the live memory after each step (a collection at each) stays far below the cage; it was ~2.5 GB live (2.6 GB before collections) before (2026-10-22).
  it('grows the city of 70,000 buildings within 1.4 GB', () => {
    const base = live();
    let peak = 0;
    const steps: string[] = [];
    let growing = 0;
    const city = buildCityTableOf('large', 7, m(4_700), (step) => {
      const now = live() - base;
      peak = Math.max(peak, now);
      // The growth's spills (one each few thousand buildings): their largest.
      if (step === 'spilled') { growing = Math.max(growing, now); return; }
      steps.push(`${step} ${(now / 1e6).toFixed(0)} MB`);
    });
    steps.push(`growing at most ${(growing / 1e6).toFixed(0)} MB`);
    console.log(`[cityGeneration] 70k city: ${new RecordTable(city.buildings).rows} buildings, table ${(city.buildings.byteLength / 1e6).toFixed(0)} MB; ${steps.join(', ')}`);
    expect(peak).toBeLessThan(1.4e9);
  }, 900_000);
});
