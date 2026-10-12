import type { IndexRequest, LodLevel, LodRequest } from './lodWorker';

/**
 * The simplifier worker (`lodWorker.ts`), started once and shared: a built
 * person's levels (`personRig.ts`) and a procedural crowd's pieces
 * (`crowdLod.ts`). Null where there are no workers (tests): callers then
 * simplify on the spot.
 */
interface Pool {
  levels(req: Omit<LodRequest, 'id'>): Promise<LodLevel[]>;
  index(req: Omit<IndexRequest, 'id' | 'kind'>): Promise<Uint32Array | null>;
}
let pool: Pool | null | undefined;

export function lodPool(): Pool | null {
  if (pool !== undefined) return pool;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return (pool = null);
  const worker = new Worker(new URL('./lodWorker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, (answer: { levels?: LodLevel[]; index?: Uint32Array | null }) => void>();
  let next = 1;
  worker.onmessage = (e: MessageEvent<{ id: number; levels?: LodLevel[]; index?: Uint32Array | null }>) => {
    waiting.get(e.data.id)?.(e.data);
    waiting.delete(e.data.id);
  };
  const ask = (message: Record<string, unknown>, transfer: Transferable[]): Promise<{ levels?: LodLevel[]; index?: Uint32Array | null }> => {
    const id = next++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
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
  };
  return pool;
}
