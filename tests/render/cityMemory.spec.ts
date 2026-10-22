import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { createBuildingLayer } from '@render/buildings/layer';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { createDecayWatch } from '@world/buildings/decayWatch';
import { siteGrading } from '@world/buildings/siteGrading';
import { buildingFloors } from '@world/buildings/floors';
import { storedBounds } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import type { Network } from '@world/network';
import type { ChangeLog } from '@core/changeLog';
import type { GraphChange } from '@world/lanelets';
import { followKerbs, newKerbBook } from '@sim/agents/kerbBays';
import { BuildingsInOrder } from '@sim/agents/buildingOrder';
import { HELD_RECORDS, TRAIT_PARKING, TRAIT_YARD, TrafficBuildingTable, docBuildings } from '@sim/agents/trafficBuildings';
import { BuildingMix, SightWalls } from '@sim/ambient/ambientIndex';
import { LotPlaces } from '@sim/ambient/lotPlaces';
import { DemandCells } from '@sim/meso/demand';
import { m } from '@world/units';

/**
 * WHAT THE PAGE HOLDS OF A CITY ROUND ONE CAMERA, SYSTEM BY SYSTEM (report "Arquitetura para cidades grandes", "A conta de memória"): the
 * cooked small and large cities opened as the page opens them, then each system that follows the buildings brought up to them in turn - a
 * walk of every record, the buildings' layer round one camera (its cells' floors, its plates), the wear's watch, the sites' grading, the
 * kerbs' entrances, the store's order - and the JS heap each one adds measured after a full collection. What a system holds per building
 * shows as bytes a building that grow with the city; what it holds per view or per cell does not. The simulation worker's own copy of the
 * buildings (`TrafficBuildingTable`) is measured apart: it lives in its worker, not on the page - its columns as loaded, the traffic
 * records it holds once every building was asked (`HELD_RECORDS`), and what the worker's readers of the buildings keep of each (the
 * sight lines' walls, the mix, the meso's demand, the places people walk to, the kerbs' entrances, the lots and yards in order).
 */

vi.mock('@render/buildings/cellWork', async (load) => {
  const real = await load<typeof import('@render/buildings/cellWork')>();
  return { ...real, runCellJob: (job: Parameters<typeof real.runCellJob>[0], reads: Parameters<typeof real.runCellJob>[1]) => real.runCellJob(job, reads) };
});

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
/** The JS heap after a full collection: the weak references of the job just run let go first (ECMA-262 ClearKeptObjects), then the finalizers the collection queued run (MDN "FinalizationRegistry"), collected again until the heap stands. */
const heap = async (): Promise<number> => {
  const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
  let was = Infinity;
  for (let round = 0; round < 8; round++) {
    await tick();
    collect();
    const now = getHeapStatistics().used_heap_size;
    if (Math.abs(was - now) < 64 * 1024) return now;
    was = now;
  }
  return was;
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

/** The JS heap and the typed arrays' memory outside it (`process.memoryUsage().arrayBuffers`): the worker's columns live there. */
const memory = async (): Promise<number> => (await heap()) + process.memoryUsage().arrayBuffers;

const flat = (): number => 0;

/** The JS heap each system adds, bytes, in the order they were brought up. */
type Held = Record<string, number>;

/** What the simulation's worker holds of the buildings: its table as loaded, the records it holds once all were asked, its readers'. */
interface WorkerHeld { readonly table: number; readonly held: number; readonly readers: Held }

async function heldBy(name: string): Promise<{ buildings: number; page: Held; worker: WorkerHeld }> {
  const doc = cooked(name);
  const table = doc.buildings.table!.table;
  let sx = 0, sy = 0;
  for (let row = 0; row < table.rows; row++) { sx += table.xs[row]!; sy += table.ys[row]!; }
  const eye = { x: sx / table.rows, y: sy / table.rows };
  const keep: unknown[] = [];
  const page: Held = {};
  let last = await heap();
  const measure = async (system: string): Promise<void> => {
    const now = await heap();
    page[system] = now - last;
    last = now;
  };

  // Every record read once and let go.
  let volumes = 0;
  for (const b of doc.buildings.all()) volumes += b.volumes.length;
  expect(volumes).toBeGreaterThan(0);
  await measure('walk');

  // The buildings' layer round one camera at the middle, until it settles.
  const layer = createBuildingLayer();
  keep.push(layer);
  layer.levelOfDetail(eye.x, eye.y, m(150), 120, null);
  for (let frame = 0; frame < 400; frame++) {
    layer.update(doc, flat, 'g');
    layer.levelOfDetail(eye.x, eye.y, m(150), 120, null);
    if (!layer.pending) break;
  }
  await measure('layer');

  // The wear's watch, one look a city day after every building was built.
  let latest = 0, built = 0;
  for (const b of doc.buildings.all()) if (b.builtAt !== undefined) { latest = Math.max(latest, b.builtAt); built++; }
  expect(built).toBeGreaterThan(0);
  const decay = createDecayWatch(doc, () => {});
  decay(latest + 60);
  keep.push(decay);
  await measure('decayWatch');

  // The sites' grading on level land: every site read and the town's platforms put together.
  const floors = buildingFloors(flat, undefined, (b: Building) => { const r = storedBounds(b, m(1)); return [r.minX, r.minY, r.maxX, r.maxY]; }, m(1));
  const sites = siteGrading(flat, undefined, m(3), (b) => { const r = storedBounds(b, m(50)); return [r.minX, r.minY, r.maxX, r.maxY]; }, floors);
  sites.changedSites(doc.buildings);
  sites.rebuild(doc.buildings);
  keep.push(sites, floors);
  await measure('siteGrading');

  // The kerbs' entrances, read whole (no street parks in this stand-in network: what is held is the entrances' book).
  const buildings = docBuildings(doc);
  const net = { state: {}, ribbons: new Map(), changesSince: () => null } as unknown as Network;
  const topologyLog = { state: {}, since: () => null } as unknown as ChangeLog<GraphChange>;
  // Every building as traffic reads it, once (a world on the page reads them through the document: `docBuildings`), measured apart from the book.
  let entrances = 0;
  for (const b of buildings.all()) entrances += b.entrances.length;
  expect(entrances).toBeGreaterThan(0);
  await measure('trafficWalk');
  const book = newKerbBook();
  followKerbs({ doc, net, topologyLog, buildings }, book, null, { rank: () => 0, laneAt: () => null, linksKey: () => 0 });
  keep.push(book);
  await measure('kerbBays');

  // The store's order and a list kept in it (the lots that park).
  const order = new BuildingsInOrder((b) => (b.traits & TRAIT_PARKING) !== 0);
  order.update({ doc, buildings });
  keep.push(order);
  await measure('buildingOrder');

  // The simulation worker's copy of the buildings (`takeTrafficMap`), measured apart: its columns, then every building asked once.
  const workerFrom = await memory();
  const copy = new RoadDoc();
  const traffic = new TrafficBuildingTable(copy.changes);
  traffic.load(doc.buildings.sections());
  const columns = (await memory()) - workerFrom;
  let asked = 0;
  for (const id of traffic.ids()) asked += traffic.get(id)!.volumes.length;
  expect(asked).toBe(volumes);
  const held = (await memory()) - workerFrom - columns;
  // The worker's readers of the buildings, each brought up in turn, as the simulation brings them up on a map sent whole.
  const readers: Held = {};
  let was = await memory();
  const reader = async (system: string, made: unknown): Promise<void> => {
    keep.push(made);
    const now = await memory();
    readers[system] = now - was;
    was = now;
  };
  const walls = new SightWalls();
  walls.sync(traffic, copy.changes);
  await reader('sightWalls', walls);
  const mix = new BuildingMix();
  mix.sync(traffic, copy.changes);
  await reader('buildingMix', mix);
  const demand = new DemandCells();
  demand.sync(traffic, copy.changes);
  await reader('demandCells', demand);
  const places = new LotPlaces({ wayOf: () => null });
  places.sync(traffic, copy.changes);
  await reader('lotPlaces', places);
  const workerBook = newKerbBook();
  followKerbs({ doc: copy, net, topologyLog, buildings: traffic }, workerBook, null, { rank: () => 0, laneAt: () => null, linksKey: () => 0 });
  await reader('kerbEntrances', workerBook);
  const lots = new BuildingsInOrder((b) => (b.traits & TRAIT_PARKING) !== 0), yards = new BuildingsInOrder((b) => (b.traits & TRAIT_YARD) !== 0);
  lots.update({ doc: copy, buildings: traffic });
  yards.update({ doc: copy, buildings: traffic });
  await reader('lotsAndYards', [lots, yards]);
  expect(lots.ids).toEqual(order.ids);
  expect(traffic.get(doc.buildings.idList().next().value!)).toBeTruthy();
  expect(keep.length).toBeGreaterThan(0);
  layer.dispose();
  return { buildings: doc.buildings.size, page, worker: { table: columns, held, readers } };
}

describe("the page's memory of a city round one camera", () => {
  it('holds what the view needs, not a share of every building', async () => {
    const small = await heldBy('small-7');
    const large = await heldBy('large-7');
    const total = (held: Held): number => Object.values(held).reduce((a, b) => a + b, 0);
    for (const [name, city] of [['small', small], ['large', large]] as const) {
      const per = Object.entries(city.page).map(([system, bytes]) => `${system} ${(bytes / city.buildings).toFixed(0)}`).join(', ');
      const w = city.worker;
      const readers = Object.entries(w.readers).map(([system, bytes]) => `${system} ${(bytes / city.buildings).toFixed(0)}`).join(', ');
      console.log(`[cityMemory] ${name}: ${city.buildings} buildings, page ${(total(city.page) / 1e6).toFixed(1)} MB (${(total(city.page) / city.buildings).toFixed(0)} B a building: ${per}), ` +
        `the simulation's copy ${(w.table / city.buildings).toFixed(0)} B a building, its records held ${(w.held / 1e6).toFixed(1)} MB (${HELD_RECORDS} at most), its readers ${(total(w.readers) / city.buildings).toFixed(0)} B a building: ${readers}`);
    }
    expect(large.buildings).toBeGreaterThan(small.buildings * 4);
    // The page's systems hold the view's share of the city, not each building's: six times the buildings, at most half again the heap and a fixed margin.
    expect(total(large.page)).toBeLessThan(total(small.page) * 1.5 + 4e6);
    // The worker's copy: its columns at most 1 KB a building (10.7 KB of records before, 2026-10-21), the records it holds a fixed
    // share however many buildings were asked (`HELD_RECORDS` of ~10 KB), its readers' at most 1.5 KB a building together (typed
    // arrays counted: ~1.1 KB in the large city, the walls' rings the most).
    for (const city of [small, large]) {
      expect(city.worker.table).toBeLessThan(1024 * city.buildings);
      expect(city.worker.held).toBeLessThan(HELD_RECORDS * 12 * 1024);
      expect(total(city.worker.readers)).toBeLessThan(1536 * city.buildings);
    }
  }, 300_000);
});
