import { type MeshAsk, TileMesher, type TileMeshes, tileBuffers } from './roadTileMesh';
import { type BlockArrays, blockBuffers, coarseArrays } from './mesh/roadLodPure';
import type { JobScope } from '../jobs/jobScope';
import { WriteBudget, keepDerivedQueued } from '../core/derivedCache';
import { MeshoptSimplifier } from 'meshoptimizer';

/** One worker of the roads' surface tiles (`roadTilePool.ts`): each tile of a share shaped and meshed whole */
/** Where a share's tiles are kept (`roadTilePool.ts` TileJob.keep). */
type KeepAsk = { readonly prefix: string; readonly keys: readonly (string | null)[] };
type Message =
  | { readonly id: number; readonly ask: MeshAsk & { readonly keep?: KeepAsk } }
  | { readonly id: number; readonly coarse: { readonly arrays: BlockArrays; readonly lock: readonly [number, number, number, number] } }
  | { readonly id: number; readonly heights: Float64Array };

/** Most time between two words to the page while working: the pool hears the worker is alive. */
const BEAT_MS = 500;
/** The tiles' writes this worker has handed the store and not seen committed, bytes: past it the next tile waits for them, its answer held (DO NOT post them to the page to keep: past the page's ceiling a tile was dropped and made again next time). */
const WRITES_MOST = 48 * 2 ** 20;
const writes = new WriteBudget(WRITES_MOST);

/** Each tile of `tiles` with a key kept in the store before its arrays leave (IndexedDB clones the value at `put`); the places of those kept. */
export async function keepTiles(tiles: readonly TileMeshes[], keep: { readonly prefix: string; readonly keys: readonly (string | null)[] }, budget: WriteBudget = writes): Promise<number[]> {
  const kept: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const key = keep.keys[i];
    if (!key) continue;
    try {
      await keepDerivedQueued(keep.prefix + key, new Map(tiles[i]!), budget);
      kept.push(i);
    } catch (error) {
      // Not kept: the page keeps it as it did before (`roadSurfaces.ts` keep).
      console.error('[roads] a road tile could not be kept by its worker', error);
    }
  }
  return kept;
}


/** The worker's answer to the page's messages, holding the shares that wait on the page for the ground's heights. */
function handler(post: JobScope): (event: MessageEvent<Message>) => void {
  /** The shares waiting on the page for the ground's heights, with the points asked. */
  const waiting = new Map<number, { readonly mesher: TileMesher; readonly points: Float64Array; readonly keep: KeepAsk | undefined }>();
  return (event) => {
    const data = event.data;
    const { id } = data;
    let spoke = performance.now();
    const beat = (): void => {
      const now = performance.now();
      if (now - spoke >= BEAT_MS) { spoke = now; post.postMessage({ id, beat: true }); }
    };
    try {
      if ('coarse' in data) {
        // A block's far level (`mesh/roadLodPure.ts`): simplified here, handed back with its buffers transferred.
        const made = coarseArrays(data.coarse.arrays, data.coarse.lock);
        post.postMessage({ id, coarse: made }, made ? blockBuffers(made) : []);
        return;
      }
      let mesher: TileMesher;
      let keep: KeepAsk | undefined;
      if ('ask' in data) {
        mesher = new TileMesher(data.ask);
        keep = data.ask.keep;
        const points = mesher.need();
        if (points.length > 0) {
          waiting.set(id, { mesher, points, keep });
          post.postMessage({ id, need: points });
          return;
        }
      } else {
        const job = waiting.get(id);
        if (!job) return;
        waiting.delete(id);
        mesher = job.mesher;
        keep = job.keep;
        mesher.give(job.points, data.heights);
      }
      const done = mesher.run(beat);
      if ('need' in done) {
        waiting.set(id, { mesher, points: done.need, keep });
        post.postMessage({ id, need: done.need });
        return;
      }
      const tiles = done.tiles;
      // Kept here, where they were made, before their arrays go to the page: the page keeps nothing of them.
      if (keep) {
        void keepTiles(tiles, keep).then((kept) => post.postMessage({ id, tiles, kept }, tileBuffers(tiles)));
        return;
      }
      post.postMessage({ id, tiles }, tileBuffers(tiles));
    } catch (error) {
      // Reported here and answered: the page builds these tiles itself (`roadSurfaces.ts`).
      console.error('[roads] surface tiles failed in their worker', error);
      waiting.delete(id);
      post.postMessage({ id, error: String(error) });
    }
  };
}

/** The road tiles' service of the job system (`job.worker.ts`). */
export function serve(self: JobScope): void {
  const handle = handler(self) as (event: MessageEvent) => void;
  // DO NOT simplify before the simplifier's WebAssembly is made: every far block failed and was drawn whole (meshoptimizer README, `MeshoptSimplifier.ready`).
  const ready = MeshoptSimplifier.ready.catch((error: unknown) => {
    // The far levels then fail one by one, each reported where it is asked (`coarseArrays`).
    console.error('[roads] meshoptimizer did not load in the road tiles worker', error);
  });
  self.onmessage = (event: MessageEvent) => void ready.then(() => handle(event));
}
