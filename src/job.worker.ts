import { readStoredTilesWith } from '@core/storedTiles';
import type { TilePartName } from '@editor/tileStore';
import { isStoreSetup, takeStoreSetup } from '@editor/workerParts';
import type { AdoptLane, FromJob, JobScope, JobService, ToJob } from './jobs/jobScope';
import type { StoredTileReader } from './tileReader';

/** ONE WORKER OF THE JOB SYSTEM (`jobs/jobPool.ts`): at the root with the other entries, since it puts every service together: every service's ports in it, each service's module loaded on its first message */

type Serve = (scope: JobScope) => void;

// The tile store read here by the far levels' bakes (`core/storedTiles.ts`), each its own part of a tile: this worker's store (`editor/workerParts.ts`) opened once per map, on the first read.
const readers = new Map<string, Promise<StoredTileReader>>();
readStoredTilesWith(async (map, key, part) => {
  let reader = readers.get(map);
  if (!reader) readers.set(map, reader = import('./tileReader').then((m) => m.storeTileReader(map)));
  return (await reader).part(key, part as TilePartName);
});
const LOADERS: Readonly<Record<JobService, () => Promise<{ serve: Serve }>>> = {
  growth: () => import('./growth.worker'),
  cityTiles: () => import('./cityTile.worker'),
  // The same tiles, made on the other kinds' workers while the map is made (`tileGenerator.ts` aside lanes).
  cityTilesAside: () => import('./cityTile.worker'),
  bays: () => import('./bays.worker'),
  conflicts: () => import('./conflictTable.worker'),
  cells: () => import('./render/buildings/cell.worker'),
  fracture: () => import('./render/buildings/fracture.worker'),
  citizenBake: () => import('./render/citizenBake.worker'),
  ecology: () => import('./render/ecology.worker'),
  flatGround: () => import('./render/flatGround.worker'),
  groundShape: () => import('./render/groundShape.worker'),
  garmentPadding: () => import('./render/people/garmentPadding.worker'),
  peopleLod: () => import('./render/people/lodWorker'),
  roadTiles: () => import('./render/roadTile.worker'),
  farRoads: () => import('./render/farRoads.worker'),
  roadStations: () => import('./render/roadStations.worker'),
  nearTiles: () => import('./render/nearTiles.worker'),
  terrainLight: () => import('./render/terrainLight.worker'),
  derivedWriter: () => import('./render/derivedWriter.worker'),
  // A tile written here has its simulation's sections baked with it (`sim/tileSections.ts`): the editor's layer does not import the simulation.
  save: () => Promise.all([import('./editor/save.worker'), import('./sim/tileSections')])
    .then(([save, sections]) => ({ serve: (scope: JobScope) => save.serve(scope, sections.bakeTileSections) })),
  // The tile store's reads on the save's worker, no queued job nor the rush's tiles beside them (`jobPool.ts` KEPT_CLEAR, `tileStore.ts` portTiles).
  tileRead: () => Promise.all([import('./editor/save.worker'), import('./sim/tileSections')])
    .then(([save, sections]) => ({ serve: (scope: JobScope) => save.serve(scope, sections.bakeTileSections) })),
};

const host = self as unknown as { onmessage: ((e: MessageEvent<ToJob | AdoptLane>) => void) | null; postMessage(message: FromJob, transfer?: Transferable[]): void };

/** A lane another thread holds the other end of (`jobPool.ts` jobChannel): its service served on the port; a service that cannot load says so on it (`laneFailed`: the pool falls back). */
function adopt({ adopt: service, port }: AdoptLane): void {
  const waiting: MessageEvent[] = [];
  let scope: JobScope | null = null;
  port.onmessage = (event) => { if (scope) scope.onmessage?.(event); else waiting.push(event); };
  void LOADERS[service]().then(({ serve }) => {
    const made: JobScope = { onmessage: null, postMessage: (data, transfer) => port.postMessage(data, transfer ?? []) };
    serve(made);
    scope = made;
    for (const event of waiting.splice(0)) made.onmessage?.(event);
  }, (error: unknown) => {
    console.error(`[jobs] the ${service} lane could not load`, error);
    port.postMessage({ laneFailed: String(error) });
  });
}
/** A port's scope once its service is loaded; the messages that came before, in order; the queued job it is on (`seq`); why its service never loaded. */
interface Port { scope: JobScope | null; readonly waiting: MessageEvent[]; seq: number | undefined; failed: string | null }
const ports = new Map<number, Port>();

/** A port's answer, with the queued job it is for: a queue port runs one job at a time (`jobPool.ts` `submitJob`). */
const answer = (port: number, entry: Port, message: { readonly data?: unknown; readonly error?: string }, transfer: Transferable[] = []): void =>
  host.postMessage({ port, ...message, ...(entry.seq !== undefined ? { seq: entry.seq } : {}) }, transfer);

host.onmessage = (event) => {
  // Where this worker's store is, said by the page before any job (`jobPool.ts` `setJobWorkerSetup`, the desktop's saves).
  if (isStoreSetup(event.data)) { takeStoreSetup(event.data); return; }
  if ('adopt' in event.data) { adopt(event.data); return; }
  const { port, service, data, seq } = event.data;
  let entry = ports.get(port);
  const message = new MessageEvent('message', { data });
  if (entry) {
    entry.seq = seq;
    // DO NOT hold a queued job behind a service that never loaded: the pool would wait for its answer for ever.
    if (entry.failed !== null) { answer(port, entry, { error: entry.failed }); return; }
    if (entry.scope) { entry.scope.onmessage?.(message); return; }
    entry.waiting.push(message);
    return;
  }
  entry = { scope: null, waiting: [message], seq, failed: null };
  ports.set(port, entry);
  const made = entry;
  void LOADERS[service]().then(({ serve }) => {
    const scope: JobScope = { onmessage: null, postMessage: (data, transfer) => answer(port, made, { data }, transfer ?? []) };
    serve(scope);
    made.scope = scope;
    for (const waiting of made.waiting.splice(0)) scope.onmessage?.(waiting);
  }, (error: unknown) => {
    made.failed = String(error);
    made.waiting.length = 0;
    answer(port, made, { error: made.failed });
  });
};
