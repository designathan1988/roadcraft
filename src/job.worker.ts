import { readStoredTilesWith } from '@core/storedTiles';
import type { TileReader } from '@sim/meso/tileFeed';
import type { FromJob, JobScope, JobService, ToJob } from './jobs/jobScope';

/** ONE WORKER OF THE JOB SYSTEM (`jobs/jobPool.ts`): at the root with the other entries, since it puts every service together: every service's ports in it, each service's module loaded on its first message */

type Serve = (scope: JobScope) => void;

// The tile store read here by the far levels' bakes (`core/storedTiles.ts`): its IndexedDB opened once per map, on the first read.
const readers = new Map<string, Promise<TileReader>>();
readStoredTilesWith(async (map, key) => {
  let reader = readers.get(map);
  if (!reader) readers.set(map, reader = import('./tileReader').then((m) => m.storeTileReader(map)));
  return (await reader).read(key);
});
const LOADERS: Readonly<Record<JobService, () => Promise<{ serve: Serve }>>> = {
  growth: () => import('./growth.worker'),
  cityTiles: () => import('./cityTile.worker'),
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
  terrainLight: () => import('./render/terrainLight.worker'),
  derivedWriter: () => import('./render/derivedWriter.worker'),
  save: () => import('./editor/save.worker'),
};

const host = self as unknown as { onmessage: ((e: MessageEvent<ToJob>) => void) | null; postMessage(message: FromJob, transfer?: Transferable[]): void };
/** A port's scope once its service is loaded; the messages that came before, in order; the queued job it is on (`seq`); why its service never loaded. */
interface Port { scope: JobScope | null; readonly waiting: MessageEvent[]; seq: number | undefined; failed: string | null }
const ports = new Map<number, Port>();

/** A port's answer, with the queued job it is for: a queue port runs one job at a time (`jobPool.ts` `submitJob`). */
const answer = (port: number, entry: Port, message: { readonly data?: unknown; readonly error?: string }, transfer: Transferable[] = []): void =>
  host.postMessage({ port, ...message, ...(entry.seq !== undefined ? { seq: entry.seq } : {}) }, transfer);

host.onmessage = (event) => {
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
