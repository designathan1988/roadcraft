import { type MeshAsk, TileMesher, tileBuffers } from './roadTileMesh';
import { type BlockArrays, coarseArrays } from './mesh/roadLodPure';
import type { JobScope } from '../jobs/jobScope';
import { MeshoptSimplifier } from 'meshoptimizer';

/** One worker of the roads' surface tiles (`roadTilePool.ts`): each tile of a share shaped and meshed whole */
type Message =
  | { readonly id: number; readonly ask: MeshAsk }
  | { readonly id: number; readonly coarse: { readonly arrays: BlockArrays; readonly lock: readonly [number, number, number, number] } }
  | { readonly id: number; readonly heights: Float64Array };

/** Most time between two words to the page while working: the pool hears the worker is alive. */
const BEAT_MS = 500;


/** The worker's answer to the page's messages, holding the shares that wait on the page for the ground's heights. */
function handler(post: JobScope): (event: MessageEvent<Message>) => void {
  /** The shares waiting on the page for the ground's heights, with the points asked. */
  const waiting = new Map<number, { readonly mesher: TileMesher; readonly points: Float64Array }>();
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
        post.postMessage({ id, coarse: made }, made ? [made.position.buffer, made.normal.buffer, made.uv.buffer, made.color.buffer, made.roadSection.buffer, made.index.buffer] as ArrayBuffer[] : []);
        return;
      }
      let mesher: TileMesher;
      if ('ask' in data) {
        mesher = new TileMesher(data.ask);
        const points = mesher.need();
        if (points.length > 0) {
          waiting.set(id, { mesher, points });
          post.postMessage({ id, need: points });
          return;
        }
      } else {
        const job = waiting.get(id);
        if (!job) return;
        waiting.delete(id);
        mesher = job.mesher;
        mesher.give(job.points, data.heights);
      }
      const done = mesher.run(beat);
      if ('need' in done) {
        waiting.set(id, { mesher, points: done.need });
        post.postMessage({ id, need: done.need });
        return;
      }
      post.postMessage({ id, tiles: done.tiles }, tileBuffers(done.tiles));
    } catch (error) {
      // Reported here and answered: the page builds these tiles itself (`roadSurfaces.ts`).
      console.error('[roads] surface tiles failed in their worker', error);
      waiting.delete(id);
      post.postMessage({ id, error: String(error) });
    }
  };
}

/** The road tiles' service of the job system (`jobs/job.worker.ts`). */
export function serve(self: JobScope): void {
  const handle = handler(self) as (event: MessageEvent) => void;
  // DO NOT simplify before the simplifier's WebAssembly is made: every far block failed and was drawn whole (meshoptimizer README, `MeshoptSimplifier.ready`).
  const ready = MeshoptSimplifier.ready.catch(() => undefined);
  self.onmessage = (event: MessageEvent) => void ready.then(() => handle(event));
}
