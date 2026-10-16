import type { JobScope } from '../jobs/jobScope';
import type { TileBaker, TileOp } from './tileStore';

/** THE AUTOSAVE'S WRITER: the text, the compression and the IndexedDB write of what the page found changed, off the page */

import { type SaveBatch, writeBatch } from './saveStore';
import { workerParts } from './workerParts';

type SaveMessage = { readonly id: number; readonly batch: SaveBatch } | { readonly id: number; readonly tiles: TileOp };

/** This service of the job system (`job.worker.ts`): each batch encoded and written, each tile call run, answered by its id; `bake`, a tile's sections baked as it is written (`sim/tileSections.ts`, given by the job worker: this layer does not import the simulation). */
export function serve(self: JobScope, bake?: TileBaker): void {
  const store = workerParts();
  self.onmessage = (event: MessageEvent<SaveMessage>) => {
    const message = event.data;
    if ('tiles' in message) {
      const { id, tiles } = message;
      // The tile store's module loaded on its first call: a save of the whole-map format never loads it.
      void import('./tileStore').then(async ({ runTileOp, tileOpTransfer }) => {
        const value = await runTileOp(store, tiles, bake);
        // A tile's texts handed over, not copied.
        self.postMessage({ id, ok: true, value }, tileOpTransfer(tiles, value));
      }).catch((error: unknown) => { console.error('[save] the worker could not reach the tiles', error); self.postMessage({ id, ok: false }); });
      return;
    }
    const { id, batch } = message;
    void writeBatch(store, batch).then(
      (ok) => self.postMessage({ id, ok }),
      (error: unknown) => { console.error('[save] the worker could not write the save', error); self.postMessage({ id, ok: false }); },
    );
  };
}
