/** What a service of the job system is given in place of a worker's own global (`jobWorker.ts`): its messages, and a way to answer. */
export interface JobScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** The services the job workers run, each a module with `serve(scope)`. */
export type JobService = 'growth' | 'bays' | 'conflicts' | 'cells' | 'fracture' | 'citizenBake' | 'ecology' | 'flatGround' | 'groundShape'
  | 'garmentPadding' | 'peopleLod' | 'roadTiles' | 'farRoads' | 'terrainLight' | 'derivedWriter' | 'save' | 'tileRead' | 'roadStations' | 'nearTiles';

/** Page to job worker: a message for a service's port (the service made on the port's first message); `seq`, a queued job's number (`jobPool.ts` `submitJob`). */
export interface ToJob { readonly port: number; readonly service: JobService; readonly data: unknown; readonly seq?: number }
/** Page to job worker: serve `adopt` on `port`, one end of a channel whose other end another thread holds (`jobPool.ts` jobChannel): that thread talks to this worker straight, no page in between. */
export interface AdoptLane { readonly adopt: JobService; readonly port: MessagePort }
/** Page to job worker: a lane let go (`JobPort.terminate`), its port's entry dropped there. */
export interface CloseLane { readonly close: number }
/** Job worker to page: a port's answer, or its failure; `seq`, the queued job it answers. */
export interface FromJob { readonly port: number; readonly data?: unknown; readonly error?: string; readonly seq?: number }
