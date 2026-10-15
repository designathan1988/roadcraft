import { type MeshAsk, TileMesher, tileBuffers } from './roadTileMesh';

/**
 * One worker of the roads' surface tiles (`roadTilePool.ts`): each tile of a
 * share shaped and meshed whole (`roadTileMesh.ts`), over the roads near it the
 * page handed over; the ground's heights asked of the page at the points read
 * (`need`, answered with `heights`); the tiles' arrays handed back (MDN,
 * "Transferable objects"). The page only uploads them.
 */
type Message =
  | { readonly id: number; readonly ask: MeshAsk }
  | { readonly id: number; readonly heights: Float64Array };

/** Most time between two words to the page while working: the pool hears the worker is alive. */
const BEAT_MS = 500;

const post = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };

/** The worker's answer to the page's messages, holding the shares that wait on the page for the ground's heights. */
function serve(): (event: MessageEvent<Message>) => void {
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

self.onmessage = serve();
