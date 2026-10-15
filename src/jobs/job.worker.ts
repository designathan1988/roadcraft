import type { FromJob, JobScope, JobService, ToJob } from './jobScope';

/** ONE WORKER OF THE JOB SYSTEM (`jobPool.ts`): every service's ports in it, each service's module loaded on its first message */

type Serve = (scope: JobScope) => void;
const LOADERS: Readonly<Record<JobService, () => Promise<{ serve: Serve }>>> = {
  bays: () => import('../bays.worker'),
  conflicts: () => import('../conflictTable.worker'),
  cells: () => import('../render/buildings/cell.worker'),
  fracture: () => import('../render/buildings/fracture.worker'),
  citizenBake: () => import('../render/citizenBake.worker'),
  ecology: () => import('../render/ecology.worker'),
  flatGround: () => import('../render/flatGround.worker'),
  groundShape: () => import('../render/groundShape.worker'),
  garmentPadding: () => import('../render/people/garmentPadding.worker'),
  peopleLod: () => import('../render/people/lodWorker'),
  roadTiles: () => import('../render/roadTile.worker'),
  terrainLight: () => import('../render/terrainLight.worker'),
  derivedWriter: () => import('../render/derivedWriter.worker'),
};

const host = self as unknown as { onmessage: ((e: MessageEvent<ToJob>) => void) | null; postMessage(message: FromJob, transfer?: Transferable[]): void };
/** Each port's scope, made once its service is loaded; the messages that came before it, held in order. */
const ports = new Map<number, { scope: JobScope | null; waiting: MessageEvent[] }>();

host.onmessage = (event) => {
  const { port, service, data } = event.data;
  let entry = ports.get(port);
  const message = new MessageEvent('message', { data });
  if (entry?.scope) { entry.scope.onmessage?.(message); return; }
  if (entry) { entry.waiting.push(message); return; }
  entry = { scope: null, waiting: [message] };
  ports.set(port, entry);
  const made = entry;
  void LOADERS[service]().then(({ serve }) => {
    const scope: JobScope = { onmessage: null, postMessage: (answer, transfer) => host.postMessage({ port, data: answer }, transfer ?? []) };
    serve(scope);
    made.scope = scope;
    for (const waiting of made.waiting.splice(0)) scope.onmessage?.(waiting);
  }, (error: unknown) => host.postMessage({ port, error: String(error) }));
};
