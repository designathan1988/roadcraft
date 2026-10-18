import { buildStreamTilePair } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { JobScope } from './jobs/jobScope';
import { workerParts } from '@editor/workerParts';
import { type PreparedTile, addTileSection, bakeStoredTile, hasTileSection, prepareTile, readTile, readTileSection, storedVersion, storedVersionBaked, writeTile } from '@editor/tileStore';
import { withGrownBuildings } from '@world/growth/grownRows';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { BAYS_SECTION } from '@sim/tileBays';
import { NETWORK_SECTION, TRAFFIC_SECTION, bakeTileSections, networkOfSection, tileBaysSection, tileNetworkSection } from '@sim/tileSections';
import { type FarCache, type FarGroundEnv, keepTileFar } from './render/buildings/farTiles';
import { type FarRoadCache, keepTileFarRoads, tileRoads } from './render/farRoadTiles';
import { keepTileNearBuildings } from './render/nearBuildings';
import type { NearTileCache } from './render/nearTileBake';
import { WriteBudget, derivedCacheOpen, keepDerivedQueuedMany, readDerived } from '@core/derivedCache';
import type { SharedGroundData } from './render/sharedGround';

/** This service of the job system (`job.worker.ts`): one tile of the streamed world built off the page (`editor/wholeMapTile.ts`, `world/tiles.ts`), asked for by `tileGenerator.ts`. */

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
  /** Stored here in the tile store's map (`workerParts`) at a version past `after`: the page never posts a tile it was handed back to the store; `records`, its records handed back prepared too (a tile of the region, `prepareTile`), else its version alone (a tile made ahead); `far`, its far levels baked here and kept. */
  readonly store?: { readonly map: string; readonly after: number; readonly records: boolean; readonly ifMissing?: boolean; readonly far?: FarTileBake | null;
    /** Nothing made: the stored tile's bays baked and added, if it has none (`addBays`, the map made, the generator's workers idle). */
    readonly baysOnly?: boolean;
    /** Nothing made: the tile the page stored at `after` with no sections (`TileStore.write`) baked and written again with them. */
    readonly sectionsOnly?: boolean };
}

/** WHAT A TILE'S MAKER BAKES ITS FAR LEVELS WITH (the page's far trees and buildings layer, `SceneHandle.farBakeEnv`): the ground and tones their jobs read, and the keys they keep a tile's level 0 under (null: that kind keeps nothing) */
export interface FarTileBake extends FarGroundEnv {
  readonly massPrefix: string | null;
  readonly roadPrefix: string | null;
  /** The ground the far roads read (`farRoads.ts`, the terrain's shared ground). */
  readonly roadGround: SharedGroundData | null;
  /** The key prefix the near products' bakes are kept under (`nearTiles.ts`): the tile's buildings as they read them kept here (`nearBuildings.ts`); null or none: nothing kept. */
  readonly nearPrefix?: string | null;
}

/** DO NOT let a tile's far levels be baked again by another worker from the store (two hundred jobs of seconds each on the queue's workers, the opening's 198 s, 2026-10-16): baked here from the tile just made, under the version just written; a failure is said and left to the page's jobs. */
/** Bytes of far levels this worker may have handed IndexedDB and not seen committed: a tile's far writes past it wait for the earlier ones (`WriteBudget`). */
const FAR_WRITES_MOST = 48 * 2 ** 20;

/** Where this worker keeps the far levels it bakes: its write budget. */
interface FarCaches { readonly budget: WriteBudget }

/** A tile's far bakes gathered, not written one by one: what `keepTileFar`, `keepTileFarRoads` and `keepTileNearBuildings` put, kept together after (`keepDerivedQueuedMany`). */
function gathered(): { readonly far: FarCache; readonly roads: FarRoadCache; readonly near: NearTileCache; readonly entries: [string, unknown][] } {
  const entries: [string, unknown][] = [];
  const put = (key: string, value: unknown): Promise<void> => { entries.push([key, value]); return Promise.resolve(); };
  return { far: { ready: derivedCacheOpen, get: (key) => readDerived(key), put }, roads: { ready: derivedCacheOpen, get: (key) => readDerived(key), put }, near: { ready: derivedCacheOpen, get: (key) => readDerived(key), put }, entries };
}

async function keepFar(records: TileRecords, full: TileRecords, version: number, far: FarTileBake, caches: FarCaches): Promise<void> {
  const into = gathered();
  const bakes = await Promise.allSettled([
    keepTileFar(full, version, far, far.massPrefix, into.far),
    keepTileFarRoads(tileRoads(records), version, far.roadGround, far.roadPrefix, into.roads),
    // What the near products read of its buildings (where no plant stands, its gardens' plants): DO NOT leave them to be made again from the rows by every bake that reads the tile.
    keepTileNearBuildings(records, full, version, far.nearPrefix ?? null, into.near),
  ]);
  for (const bake of bakes) if (bake.status === 'rejected') console.warn(`[city tile] tile ${records.key}'s far level not kept; the far jobs bake it`, bake.reason);
  // One transaction for them all, queued, not waited for: the page's far job for the tile asks after this answer, and its read comes after this write.
  await keepDerivedQueuedMany(into.entries, caches.budget);
}

/** The streamed tile built (its key and records), stored here (its version, and its records prepared when asked for), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords }
  | { readonly key: number; readonly stored: number | null; readonly prepared?: PreparedTile; readonly existed?: boolean; readonly legacy?: boolean; readonly bays?: boolean }
  | { readonly i: number; readonly j: number; readonly error: string };

/** A tile asked only if missing (`StreamTileAsk.store.ifMissing`): what the store has of it, read here, or null to make it. */
async function storedAnswer(store: NonNullable<StreamTileAsk['store']>, i: number, j: number): Promise<StreamTileAnswer | null> {
  const key = tileKey(i, j);
  // A tile the page wrote and whose bake a reload cut short baked here first: DO NOT refuse it as 'legacy' (the reopening then read it on the store's lanes, behind the rush's tiles, conf37).
  const version = await storedVersionBaked(stored(), store.map, key, (r) => bakeTileSections(r, true), !store.records);
  if (version === null) return null;
  if (version === 'legacy') return { key, stored: null, legacy: true };
  // Whether its bays are stored too (a world reopened): the page asks no worker for them again (`TileStore.addBays`).
  if (!store.records) return { key, stored: version, existed: true, ...((await hasTileSection(stored(), store.map, key, BAYS_SECTION)) ? { bays: true } : {}) };
  const records = await readTile(stored(), store.map, key);
  if (!records) return null;
  await addBays(store.map, records);
  // DO NOT solve the junctions of a tile stored with them (`NETWORK_SECTION`, baked at its version from these records): read, as the simulation reads them (`tileReader.ts` network); solved and added only where it has none.
  const section = await readTileSection(stored(), store.map, key, NETWORK_SECTION);
  const network = section && 'value' in section ? networkOfSection(section.value) : null;
  if (network) return { key, stored: records.version, prepared: { ...prepareTile(records, false), network }, existed: true };
  const prepared = prepareTile(records);
  await addNetwork(store.map, records, prepared);
  return { key, stored: records.version, prepared, existed: true };
}

/** DO NOT let the page post a tile's junctions to the simulation's worker (read here, cloned to the page, cloned again to the worker): solved here for the page anyway (`prepareTile`), they are added to the stored tile, that section alone, and the worker reads them from the store (`tileReader.ts` network). Same chain as `addBays`. */
async function addNetwork(map: string, records: TileRecords, prepared: PreparedTile): Promise<void> {
  if (!prepared.network) return;
  try {
    if (await readTileSection(stored(), map, records.key, NETWORK_SECTION)) return;
    if (!(await addTileSection(stored(), map, records.key, records.version, NETWORK_SECTION, tileNetworkSection(prepared.network)))) console.warn(`[city tile] tile ${records.key}'s network was not added`);
  } catch (error) {
    console.warn(`[city tile] tile ${records.key}'s network was not added`, error);
  }
}

/** A stored tile's bays added (`addBays`): its version, null when none is stored (nothing is made). */
async function baysAnswer(map: string, i: number, j: number): Promise<StreamTileAnswer> {
  const key = tileKey(i, j);
  // DO NOT read the whole tile to learn it has its bays: its head says so.
  if (await hasTileSection(stored(), map, key, BAYS_SECTION)) {
    const version = await storedVersion(stored(), map, key);
    return { key, stored: typeof version === 'number' ? version : null, existed: true, bays: true };
  }
  const records = await readTile(stored(), map, key);
  if (records) await addBays(map, records);
  return { key, stored: records ? records.version : null, existed: records !== null };
}

/** DO NOT bake every tile's bays in the opening's rush (a grid and a way out per stall, the dearest part of a tile after its growth): a tile made ahead is stored without them, and they are baked and added here, that section alone: once the map is made, by the generator's idle workers from the camera's tile outwards (`WorldStreamer` bays, `baysAnswer`), and when a tile not reached yet is loaded into the region.
 *  Run while the page waits for this answer on the tile's chain (`TileStore.load`): no write of the tile comes between. A failure is said; the simulation works them out as it does for a tile without them. */
async function addBays(map: string, records: TileRecords): Promise<void> {
  try {
    if (await readTileSection(stored(), map, records.key, BAYS_SECTION)) return;
    const traffic = await readTileSection(stored(), map, records.key, TRAFFIC_SECTION);
    if (!traffic || !('value' in traffic)) return;
    const section = tileBaysSection(withGrownBuildings(records), traffic.value);
    if (section && !(await addTileSection(stored(), map, records.key, records.version, BAYS_SECTION, section))) console.warn(`[city tile] tile ${records.key}'s bays were not added`);
  } catch (error) {
    console.warn(`[city tile] tile ${records.key}'s bays were not added`, error);
  }
}

/** A tile's buildings as current records, each made once (`migrateBuilding`), those it cannot read left out as every reader of them leaves them. */
function migratedOnce(buildings: TileRecords['buildings']): TileRecords['buildings'] {
  const out: Building[] = [];
  for (const raw of buildings) { const b = migrateBuilding(raw); if (b) out.push(b); }
  return out as unknown as TileRecords['buildings'];
}

/** The tile store's parts as this worker opens them (`workerParts`: IndexedDB, or the desktop's saves writer through its own port), on the first tile stored. */
let parts: ReturnType<typeof workerParts> | null = null;
const stored = (): ReturnType<typeof workerParts> => (parts ??= workerParts());

export function serve(self: JobScope): void {
  // The far levels' writes of this worker held under one budget (the V8 cage the page and its workers share).
  const budget = new WriteBudget(FAR_WRITES_MOST);
  const caches: FarCaches = { budget };
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { store, i, j } = event.data;
    if (store?.sectionsOnly) {
      const key = tileKey(i, j);
      bakeStoredTile(stored(), store.map, key, store.after, (r) => bakeTileSections(r, true)).then(
        (baked) => self.postMessage({ key, stored: baked ? store.after : null, existed: true } satisfies StreamTileAnswer),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j}'s sections could not be baked: ${String(error)}` } satisfies StreamTileAnswer));
      return;
    }
    if (store?.baysOnly) {
      baysAnswer(store.map, i, j).then((answer) => self.postMessage(answer),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j}'s bays could not be added: ${String(error)}` } satisfies StreamTileAnswer));
      return;
    }
    // DO NOT make a tile the store has: looked up here, where the store is open, not through the save worker's lanes.
    if (store?.ifMissing) {
      storedAnswer(store, i, j).then((answer) => (answer ? self.postMessage(answer) : make(self, event.data, caches)),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j} could not be looked up: ${String(error)}` } satisfies StreamTileAnswer));
      return;
    }
    make(self, event.data, caches);
  };
}

/** The tile made (and stored, with its far levels, when asked). */
function make(self: JobScope, ask: StreamTileAsk, caches: FarCaches): void {
  const { options, i, j, store } = ask;
  try {
    // Stored with its grown buildings as rows (`world/growth/rows.ts`); baked and handed to the page whole, as just grown (never made again here).
    const pair = buildStreamTilePair(options, i, j);
    if (!store) { self.postMessage({ key: tileKey(i, j), records: pair.records } satisfies StreamTileAnswer); return; }
    const version = Math.max(pair.records.version, store.after) + 1;
    // Every building migrated once for all the tile's bakes (its sections, its far levels, the page's records): the same objects, their derived products worked out once.
    const records = { ...pair.records, version }, full = { ...pair.full, version, buildings: migratedOnce(pair.full.buildings) };
    // Its sections baked here with it, once (`sim/tileSections.ts`); its bays only for a tile of the region (records asked), a tile made ahead takes them when it is loaded (`addBays`).
    void writeTile(stored(), store.map, records, (r) => bakeTileSections(r, store.records), full).then(
      async ({ ok }) => {
        // Its far levels kept before the page hears of it: the far tree's job for it then finds them (`farTiles.ts` `runFarJob` level 0).
        if (ok && store.far) await keepFar(records, full, version, store.far, caches);
        // The records handed back prepared (migrated and interned here, `prepareTile`: the page only files them); kept for the page even when the write failed.
        const answer: StreamTileAnswer = { key: tileKey(i, j), stored: ok ? version : null, ...(store.records ? { prepared: prepareTile(full, true, records.grown) } : {}) };
        self.postMessage(answer);
      },
      (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j} was made and not stored: ${String(error)}` } satisfies StreamTileAnswer));
  } catch (error) {
    // Told and answered: the asker decides (`tileGenerator.ts`).
    console.error(`[city tile] tile ${i},${j} failed`, error);
    self.postMessage({ i, j, error: String(error) } satisfies StreamTileAnswer);
  }
}
