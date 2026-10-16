/** What a service of the job system is given in place of a worker's own global (`jobWorker.ts`): its messages, and a way to answer. */
export interface JobScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** The services the job workers run, each a module with `serve(scope)`. */
export type JobService = 'growth' | 'cityTiles' | 'bays' | 'conflicts' | 'cells' | 'fracture' | 'citizenBake' | 'ecology' | 'flatGround' | 'groundShape'
  | 'garmentPadding' | 'peopleLod' | 'roadTiles' | 'terrainLight' | 'derivedWriter';

/** Page to job worker: a message for a service's port (the service made on the port's first message). */
export interface ToJob { readonly port: number; readonly service: JobService; readonly data: unknown }
/** Job worker to page: a port's answer, or its failure. */
export interface FromJob { readonly port: number; readonly data?: unknown; readonly error?: string }
