import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { createBuildingLayer } from '@render/buildings/layer';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { m } from '@world/units';

/**
 * WHAT THE BUILDINGS LAYER HOLDS ON THE PAGE ROUND ONE CAMERA (report "Arquitetura para cidades grandes", "A conta de memória"): the
 * cooked small and large cities opened as the page opens them, the layer updated round one camera at the centre until it settles, the JS
 * heap it adds measured after a full collection, and the building records left decoded counted (`TableRows.held`). The workers' masses are
 * left out (their jobs answered with none: what they make lives in the workers and on the GPU); the near cells' detail is made on the page.
 */

vi.mock('@render/buildings/cellWork', async (load) => {
  const real = await load<typeof import('@render/buildings/cellWork')>();
  const masses = new Set<string>([]);
  return {
    ...real,
    runCellJob: (job: Parameters<typeof real.runCellJob>[0], reads: Parameters<typeof real.runCellJob>[1]) => masses.has(job.kind)
      ? { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries: [], mass: null } }
      : real.runCellJob(job, reads),
  };
});

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
/** The heap after a full collection, the weak references of the job just run let go first (a `WeakRef`'s target is kept to the end of the job that made or read it: ECMA-262 ClearKeptObjects). */
const heap = async (): Promise<{ js: number; arrays: number }> => {
  await new Promise((done) => setTimeout(done, 0));
  collect(); collect();
  return { js: getHeapStatistics().used_heap_size, arrays: process.memoryUsage().arrayBuffers };
};

function cooked(name: string): RoadDoc {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL(`${name}.table.gz`, dir)));
  const table = tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const doc = new RoadDoc();
  const city = preparedCity(data, table);
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: city.table!, whole: true });
  return doc;
}

const flat = (): number => 0;

/** `walkBytes`: the JS heap a walk of every record leaves held by the table (`tableRows.ts`: a slot a row, its shared members held weakly); `layerBytes`: the JS heap the layer adds; `arrayBytes`: the array buffers it adds (outside the JS heap: its columns, the masses' arrays). */
interface Held { readonly buildings: number; readonly walkBytes: number; readonly layerBytes: number; readonly arrayBytes: number; readonly decoded: number; readonly ms: number }

/** The layer updated round one camera over the city's middle until it settles; the heap it adds and the records left decoded. */
async function heldRound(name: string): Promise<Held> {
  const doc = cooked(name);
  // The middle of the buildings, read off the table's columns (no record decoded for it).
  const table = doc.buildings.table!.table;
  let sx = 0, sy = 0;
  for (let row = 0; row < table.rows; row++) { sx += table.xs[row]!; sy += table.ys[row]!; }
  const eye = { x: sx / table.rows, y: sy / table.rows };
  // Every record read once and let go, as the layer's first look reads them: what the table keeps of such a walk measured apart from the layer.
  const walkFrom = await heap();
  let volumes = 0;
  for (const b of doc.buildings.all()) volumes += b.volumes.length;
  expect(volumes).toBeGreaterThan(0);
  const before = await heap();
  const started = performance.now();
  const layer = createBuildingLayer();
  layer.levelOfDetail(eye.x, eye.y, m(150), 120, null);
  for (let frame = 0; frame < 400; frame++) {
    layer.update(doc, flat, 'g');
    layer.levelOfDetail(eye.x, eye.y, m(150), 120, null);
    if (!layer.pending) break;
  }
  const ms = performance.now() - started;
  const after = await heap();
  const decoded = doc.buildings.table!.held();
  // Kept alive to here: what is measured is what the live layer holds.
  expect(layer.books()).toBeTruthy();
  layer.dispose();
  return { buildings: doc.buildings.size, walkBytes: before.js - walkFrom.js, layerBytes: after.js - before.js, arrayBytes: after.arrays - before.arrays, decoded, ms };
}

describe("the buildings layer's page memory", () => {
  it('holds a bounded number of decoded records round one camera, whatever the size of the city', async () => {
    const small = await heldRound('small-7');
    const large = await heldRound('large-7');
    const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
    for (const [name, held] of [['small', small], ['large', large]] as const) {
      console.log(`[layerMemory] ${name}: ${held.buildings} buildings, a walk of the table ${mb(held.walkBytes)} MB, layer ${mb(held.layerBytes)} MB of JS heap and ${mb(held.arrayBytes)} MB of arrays, ${held.decoded} records decoded, ${held.ms.toFixed(0)} ms`);
    }
    expect(large.buildings).toBeGreaterThan(small.buildings * 4);
    // The records held decoded: the table's recent reads (`tableRows.ts` RECENT, 2048) and the few the view's cells and signature buildings read, the same for six times the buildings.
    expect(large.decoded).toBeLessThan(2048);
    expect(large.decoded).toBeLessThan(small.decoded * 1.5 + 64);
    // The layer's heap is the view's, not the city's (it held every record shown, sent and kept: 55 MB of the large city before, 2026-10-21).
    expect(large.layerBytes).toBeLessThan(small.layerBytes * 1.5);
    // A walk of every record leaves a slot a row in the table, never the records nor their shared members (13.8 MB of the large city before).
    expect(large.walkBytes / large.buildings).toBeLessThan(600);
  }, 300_000);
});
