import type { JobScope } from '../jobs/jobScope';

/** THE AUTOSAVE'S WRITER: the text, the compression and the IndexedDB write of what the page found changed, off the page */

import { type SaveBatch, writeBatch } from './saveStore';
import { StoreTurns } from './storeTurns';
import { workerParts } from './workerParts';

type SaveMessage = { readonly id: number; readonly batch: SaveBatch };

/** This service of the job system (`job.worker.ts`): each batch encoded and written, answered by its id. */
export function serve(self: JobScope): void {
  const store = workerParts();
  // The writes one after another on this worker (`storeTurns.ts`).
  const turns = new StoreTurns();
  self.onmessage = (event: MessageEvent<SaveMessage>) => {
    const { id, batch } = event.data;
    void turns.write(() => writeBatch(store, batch)).then(
      (ok) => self.postMessage({ id, ok }),
      (error: unknown) => { console.error('[save] the worker could not write the save', error); self.postMessage({ id, ok: false }); },
    );
  };
}
