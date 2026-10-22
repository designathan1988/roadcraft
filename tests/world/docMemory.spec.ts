import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { setFlagsFromString, getHeapStatistics } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn, tableRecords } from '@world/buildings/recordTable';

/** WHAT THE DOCUMENT HOLDS PER BUILDING (report "Arquitetura para cidades grandes", "A conta de memória"): the large city opened as the page opens it (`main.ts` `preparedCity`, `RoadDoc.replaceFromJSON`), the JS heap measured after a full collection, the map's roads and lots measured apart and taken off */

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
const heap = (): number => { collect(); collect(); return getHeapStatistics().used_heap_size; };

/** The large city of seed 7 as `scripts/cook-cities.mjs` writes it: `buildLargeCityMap(7)` prepared by `prepareCity`. */
function cookedLarge(): { data: SerializedDoc; table: ArrayBufferLike } {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL('large-7.json.gz', dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL('large-7.table.gz', dir)));
  return { data, table: tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

/** The heap a document made by `open` holds, after a collection, with the document itself kept alive until measured. */
function held(open: () => RoadDoc): { bytes: number; buildings: number } {
  const before = heap();
  const doc = open();
  const after = heap();
  return { bytes: after - before, buildings: doc.buildings.size };
}

describe("the document's memory", () => {
  it('holds the large city with its buildings in the table, a few hundred bytes of JS heap each', () => {
    const { data, table } = cookedLarge();
    const bare = held(() => { const doc = new RoadDoc(); doc.replaceFromJSON({ ...data, buildings: [] }, { repair: false }); return doc; });
    // As the page held it before (`tableRecords`: every record decoded and kept).
    const decoded = held(() => { const doc = new RoadDoc(); doc.replaceFromJSON({ ...data, buildings: tableRecords(table) as never }, { repair: false, preparedBuildings: true }); return doc; });
    const opened = held(() => { const doc = new RoadDoc(); const city = preparedCity(data, table); doc.replaceFromJSON(city.data, { repair: false, buildingTable: city.table!, whole: true }); return doc; });
    const n = opened.buildings;
    const kb = (bytes: number): string => (bytes / 1024).toFixed(2);
    const before = (decoded.bytes - bare.bytes) / n, after = (opened.bytes - bare.bytes) / n;
    console.log(`[docMemory] ${n} buildings; roads, lots and the rest ${(bare.bytes / 1e6).toFixed(1)} MB; buildings decoded ${kb(before)} KB a building of JS heap, from the table ${kb(after)} KB (table ${kb(table.byteLength / n)} KB a building outside the heap)`);
    expect(decoded.buildings).toBe(n);
    expect(n).toBeGreaterThan(5000);
    // The table's index (12 B a building) and the slots of the records read (WeakRef, 4-8 B): far below the ~300 B the report allows.
    expect(after).toBeLessThan(300);
    expect(after).toBeLessThan(before / 10);
  });
});
