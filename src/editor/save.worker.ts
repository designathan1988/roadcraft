import type { JobScope } from '../jobs/jobScope';
import type { TileOp } from './tileStore';

/** THE AUTOSAVE'S WRITER: the text, the compression and the IndexedDB write of what the page found changed, off the page */

import { type SaveBatch, indexedDbParts, openSaves, SAVES_STORE, writeBatch } from './saveStore';

type SaveMessage = { readonly id: number; readonly batch: SaveBatch } | { readonly id: number; readonly tiles: TileOp };

/** This service of the job system (`job.worker.ts`): each batch encoded and written, each tile call run, answered by its id. */
export function serve(self: JobScope): void {
  const store = indexedDbParts(openSaves, SAVES_STORE);
  self.onmessage = (event: MessageEvent<SaveMessage>) => {
    const message = event.data;
    if ('tiles' in message) {
      const { id, tiles } = message;
      // The tile store's module loaded on its first call: a save of the whole-map format never loads it.
      void import('./tileStore').then(({ runTileOp }) => runTileOp(store, tiles)).then(
        (value) => self.postMessage({ id, ok: true, value }),
        (error: unknown) => { console.error('[save] the worker could not reach the tiles', error); self.postMessage({ id, ok: false }); },
      );
      return;
    }
    const { id, batch } = message;
    void writeBatch(store, batch).then(
      (ok) => self.postMessage({ id, ok }),
      (error: unknown) => { console.error('[save] the worker could not write the save', error); self.postMessage({ id, ok: false }); },
    );
  };
}
