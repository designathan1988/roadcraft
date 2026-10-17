import { buildStreamTilePair } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { JobScope } from './jobs/jobScope';
import { workerParts } from '@editor/workerParts';
import { type PreparedTile, addTileSection, prepareTile, readTile, readTileSection, storedVersion, writeTile } from '@editor/tileStore';
import { withGrownBuildings } from '@world/growth/grownRows';
import { BAYS_SECTION } from '@sim/tileBays';
import { TRAFFIC_SECTION, bakeTileSections, tileBaysSection } from '@sim/tileSections';
import { type FarGroundEnv, keepTileFar, queuedFarCache } from './render/buildings/farTiles';
import { keepTileFarRoads, queuedRoadCache, tileRoads } from './render/farRoadTiles';
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
    readonly baysOnly?: boolean };
}

/** WHAT A TILE'S MAKER BAKES ITS FAR LEVELS WITH (the page's far trees and buildings layer, `SceneHandle.farBakeEnv`): the ground and tones their jobs read, and the keys they keep a tile's level 0 under (null: that kind keeps nothing) */
export interface FarTileBake extends FarGroundEnv {
  readonly massPrefix: string | null;
  readonly roadPrefix: string | null;
  /** The ground the far roads read (`farRoads.ts`, the terrain's shared ground). */
  readonly roadGround: SharedGroundData | null;
}

/** DO NOT let a tile's far levels be baked again by another worker from the store (two hundred jobs of seconds each on the queue's workers, the opening's 198 s, 2026-10-16): baked here from the tile just made, under the version just written; a failure is said and left to the page's jobs. */
async function keepFar(records: TileRecords, full: TileRecords, version: number, far: FarTileBake): Promise<void> {
  const bakes = await Promise.allSettled([
    // Queued, not waited for (`keepDerivedQueued`): the page's far job for the tile asks after this answer, and its read comes after these writes.
    keepTileFar(full, version, far, far.massPrefix, queuedFarCache),
    keepTileFarRoads(tileRoads(records), version, far.roadGround, far.roadPrefix, queuedRoadCache),
  ]);
  for (const bake of bakes) if (bake.status === 'rejected') console.warn(`[city tile] tile ${records.key}'s far level not kept; the far jobs bake it`, bake.reason);
}

/** The streamed tile built (its key and records), stored here (its version, and its records prepared when asked for), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords }
  | { readonly key: number; readonly stored: number | null; readonly prepared?: PreparedTile; readonly existed?: boolean; readonly legacy?: boolean }
  | { readonly i: number; readonly j: number; readonly error: string };

/** A tile asked only if missing (`StreamTileAsk.store.ifMissing`): what the store has of it, read here, or null to make it. */
async function storedAnswer(store: NonNullable<StreamTileAsk['store']>, i: number, j: number): Promise<StreamTileAnswer | null> {
  const key = tileKey(i, j);
  const version = await storedVersion(stored(), store.map, key);
  if (version === null) return null;
  if (version === 'legacy') return { key, stored: null, legacy: true };
  if (!store.records) return { key, stored: version, existed: true };
  const records = await readTile(stored(), store.map, key);
  if (!records) return null;
  await addBays(store.map, records);
  return { key, stored: records.version, prepared: prepareTile(records), existed: true };
}

/** A stored tile's bays added (`addBays`): its version, null when none is stored (nothing is made). */
async function baysAnswer(map: string, i: number, j: number): Promise<StreamTileAnswer> {
  const key = tileKey(i, j);
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

/** The tile store's parts as this worker opens them (`workerParts`: IndexedDB, or the desktop's saves writer through its own port), on the first tile stored. */
let parts: ReturnType<typeof workerParts> | null = null;
const stored = (): ReturnType<typeof workerParts> => (parts ??= workerParts());

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { store, i, j } = event.data;
    if (store?.baysOnly) {
      baysAnswer(store.map, i, j).then((answer) => self.postMessage(answer),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j}'s bays could not be added: ${String(error)}` } satisfies StreamTileAnswer));
      return;
    }
    // DO NOT make a tile the store has: looked up here, where the store is open, not through the save worker's lanes.
    if (store?.ifMissing) {
      storedAnswer(store, i, j).then((answer) => (answer ? self.postMessage(answer) : make(self, event.data)),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j} could not be looked up: ${String(error)}` } satisfies StreamTileAnswer));
      return;
    }
    make(self, event.data);
  };
}

/** The tile made (and stored, with its far levels, when asked). */
function make(self: JobScope, ask: StreamTileAsk): void {
  const { options, i, j, store } = ask;
  try {
    // Stored with its grown buildings as rows (`world/growth/rows.ts`); baked and handed to the page whole, as just grown (never made again here).
    const pair = buildStreamTilePair(options, i, j);
    if (!store) { self.postMessage({ key: tileKey(i, j), records: pair.records } satisfies StreamTileAnswer); return; }
    const version = Math.max(pair.records.version, store.after) + 1;
    const records = { ...pair.records, version }, full = { ...pair.full, version };
    // Its sections baked here with it, once (`sim/tileSections.ts`); its bays only for a tile of the region (records asked), a tile made ahead takes them when it is loaded (`addBays`).
    void writeTile(stored(), store.map, records, (r) => bakeTileSections(r, store.records), full).then(
      async ({ ok }) => {
        // Its far levels kept before the page hears of it: the far tree's job for it then finds them (`farTiles.ts` `runFarJob` level 0).
        if (ok && store.far) await keepFar(records, full, version, store.far);
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
