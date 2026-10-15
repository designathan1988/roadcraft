import type { SurfaceShape, TileRect } from './mesh/tileShape';
import { type TilePolys, type TileSpec, tileShapes } from './roadTileShape';

/**
 * One worker of the roads' surface tiles (`roadTilePool.ts`): each tile's
 * bands cut, clipped and triangulated (`tileShapes`), answered with the job's
 * id, the shapes' buffers handed over (MDN, "Transferable objects"). The page
 * reads each vertex's height and frame after (`meshTileShape`).
 */
interface Ask {
  readonly id: number;
  readonly specs: readonly TileSpec[];
  readonly tiles: readonly { readonly rect: TileRect; readonly into: TilePolys }[];
}

/** Most time between two words to the page while working: the pool hears the worker is alive. */
const BEAT_MS = 500;

self.onmessage = (event: MessageEvent<Ask>) => {
  const { id, specs, tiles } = event.data;
  let spoke = performance.now();
  try {
    const shapes: [string, SurfaceShape][][] = [];
    const transfer: ArrayBuffer[] = [];
    for (const tile of tiles) {
      const made = [...tileShapes(tile.into, tile.rect, specs)];
      for (const [, shape] of made) {
        for (const piece of shape.pieces) transfer.push(piece.xy.buffer as ArrayBuffer, piece.tris.buffer as ArrayBuffer);
        for (const ring of shape.skirts ?? []) transfer.push(ring.edges.buffer as ArrayBuffer);
      }
      shapes.push(made);
      const now = performance.now();
      if (now - spoke >= BEAT_MS) { spoke = now; self.postMessage({ id, beat: true }); }
    }
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, shapes }, transfer);
  } catch (error) {
    // Reported here and answered: the page builds these tiles itself (`roadSurfaces.ts`).
    console.error('[roads] surface tiles failed in their worker', error);
    self.postMessage({ id, error: String(error) });
  }
};
