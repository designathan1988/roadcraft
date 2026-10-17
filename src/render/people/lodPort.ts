import type { IndexRequest, LadderRequest, LodLevel, LodRequest } from './lodWorker';
import type { PartArrays, PartLevels, Weld } from '../partLevelsWork';

/** The simplifier pool as a body's levels ask it (`personRig.ts`): handed in by the page (`lodPool.ts`); none in a worker, which simplifies on its own thread */
/** DO NOT import the pool where a person is built: the bake worker builds people (`personBuild.ts`), and the pool's import of the job system made a cycle through `job.worker.ts`. */

export interface LodPool {
  levels(req: Omit<LodRequest, 'id'>): Promise<LodLevel[]>;
  index(req: Omit<IndexRequest, 'id' | 'kind'>): Promise<Uint32Array | null>;
  ladder(req: Omit<LadderRequest, 'id' | 'kind'>): Promise<Uint32Array[]>;
  /** A vehicle part's levels, welded, simplified and creased there (`partLevelsWork.ts`). */
  part(part: PartArrays, weld: Weld): Promise<PartLevels>;
}

let provider: () => LodPool | null = () => null;

/** The page's pool (`lodPool`), given once by the page that draws people. */
export function providePeopleLod(pool: () => LodPool | null): void {
  provider = pool;
}

/** The pool, where the page gave one. */
export const peopleLod = (): LodPool | null => provider();
