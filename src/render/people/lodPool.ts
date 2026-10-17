import { jobPort } from '../../jobs/jobPool';
import type { LodLevel } from './lodWorker';
import type { LodPool as Pool } from './lodPort';
import type { PartLevels } from '../partLevelsWork';

/** The simplifier worker (`lodWorker.ts`), started once and shared: a built person's levels, a vehicle part's */
let pool: Pool | null | undefined;

export function lodPool(): Pool | null {
  if (pool !== undefined) return pool;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return (pool = null);
  const worker = jobPort('peopleLod');
  type Answer = { id: number; levels?: LodLevel[]; index?: Uint32Array | null; ladder?: Uint32Array[]; part?: PartLevels; error?: string };
  const waiting = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();
  let next = 1;
  worker.onmessage = (e: MessageEvent<Answer>) => {
    const ask = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (e.data.error !== undefined) {
      console.error(`[lod worker] request ${e.data.id}: ${e.data.error}`);
      ask?.reject(new Error(`lod worker: ${e.data.error}`));
    }
    else ask?.resolve(e.data);
  };
  /** DO NOT leave them pending: an item whose levels never came was never drawn, silently, on everybody who wore it. */
  const failAll = (why: string): void => {
    console.error(`[lod worker] ${why}`);
    for (const ask of waiting.values()) ask.reject(new Error(`lod worker: ${why}`));
    waiting.clear();
  };
  worker.onerror = (e) => { e.preventDefault(); failAll(e.message || 'error'); };
  worker.onmessageerror = () => failAll('a message could not be read');
  const ask = (message: Record<string, unknown>, transfer: Transferable[]): Promise<Answer> => {
    const id = next++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer);
    });
  };
  pool = {
    async levels(req) {
      return (await ask({ ...req }, [])).levels ?? [];
    },
    // The positions and the index are made for the request: sent, not copied.
    async index(req) {
      return (await ask({ kind: 'index', ...req }, [req.positions.buffer, req.index.buffer])).index ?? null;
    },
    // The part's arrays are copies made for the request: sent, not copied again.
    async part(part, weld) {
      const transfer = [part.position.array.buffer, ...(part.color ? [part.color.array.buffer] : []), ...(part.normal ? [part.normal.array.buffer] : []),
        ...(part.index ? [part.index.buffer] : [])] as ArrayBuffer[];
      return (await ask({ kind: 'part', part, weld }, transfer)).part!;
    },
    async ladder(req) {
      return (await ask({ kind: 'ladder', ...req }, [req.positions.buffer, req.attributes.buffer, req.index.buffer])).ladder ?? [];
    },
  };
  return pool;
}
