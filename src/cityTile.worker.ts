import { buildStreamTile } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { JobScope } from './jobs/jobScope';
import { SAVES_STORE, indexedDbParts, openSaves } from '@editor/saveStore';
import { runTileOp } from '@editor/tileStore';
import { bakeTileSections } from '@sim/tileSections';

/** This service of the job system (`job.worker.ts`): one tile of the streamed world built off the page (`editor/wholeMapTile.ts`, `world/tiles.ts`), asked for by `tileGenerator.ts`. */

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
  /** Stored here in the tile store's map (the browser's IndexedDB) at a version past `after`, and only that version answered: the page never holds a tile it only needs made. */
  readonly store?: { readonly map: string; readonly after: number };
}

/** The streamed tile built (its key and records), stored here (its version), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords } | { readonly key: number; readonly stored: number | null }
  | { readonly i: number; readonly j: number; readonly error: string };

/** The tile store's parts in this worker's IndexedDB, opened on the first tile stored. */
let parts: ReturnType<typeof indexedDbParts> | null = null;
const stored = (): ReturnType<typeof indexedDbParts> => (parts ??= indexedDbParts(openSaves, SAVES_STORE));

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { options, i, j, store } = event.data;
    try {
      const records = buildStreamTile(options, i, j);
      if (!store) { self.postMessage({ key: tileKey(i, j), records } satisfies StreamTileAnswer); return; }
      const version = Math.max(records.version, store.after) + 1;
      // Its simulation's sections baked here with it, once (`sim/tileSections.ts`).
      void runTileOp(stored(), { op: 'write', map: store.map, records: { ...records, version } }, bakeTileSections).then(
        (ok) => self.postMessage({ key: tileKey(i, j), stored: ok === true ? version : null } satisfies StreamTileAnswer),
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j} was made and not stored: ${String(error)}` } satisfies StreamTileAnswer));
    } catch (error) {
      // Told and answered: the asker decides (`tileGenerator.ts`).
      console.error(`[city tile] tile ${i},${j} failed`, error);
      self.postMessage({ i, j, error: String(error) } satisfies StreamTileAnswer);
    }
  };
}
