import { buildStreamTile } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { JobScope } from './jobs/jobScope';
import { SAVES_STORE, indexedDbParts, openSaves } from '@editor/saveStore';
import { type PreparedTile, prepareTile, writeTile } from '@editor/tileStore';
import { bakeTileSections } from '@sim/tileSections';

/** This service of the job system (`job.worker.ts`): one tile of the streamed world built off the page (`editor/wholeMapTile.ts`, `world/tiles.ts`), asked for by `tileGenerator.ts`. */

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
  /** Stored here in the tile store's map (the browser's IndexedDB) at a version past `after`: the page never posts a tile it was handed back to the store; `records`, its records handed back prepared too (a tile of the region, `prepareTile`), else its version alone (a tile made ahead). */
  readonly store?: { readonly map: string; readonly after: number; readonly records: boolean };
}

/** The streamed tile built (its key and records), stored here (its version, and its records prepared when asked for), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords } | { readonly key: number; readonly stored: number | null; readonly prepared?: PreparedTile }
  | { readonly i: number; readonly j: number; readonly error: string };

/** The tile store's parts in this worker's IndexedDB, opened on the first tile stored. */
let parts: ReturnType<typeof indexedDbParts> | null = null;
const stored = (): ReturnType<typeof indexedDbParts> => (parts ??= indexedDbParts(openSaves, SAVES_STORE));

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { options, i, j, store } = event.data;
    try {
      const fresh = buildStreamTile(options, i, j);
      if (!store) { self.postMessage({ key: tileKey(i, j), records: fresh } satisfies StreamTileAnswer); return; }
      const version = Math.max(fresh.version, store.after) + 1;
      const records = { ...fresh, version };
      // Its sections baked here with it, once (`sim/tileSections.ts`).
      void writeTile(stored(), store.map, records, bakeTileSections).then(
        ({ ok }) => {
          // The records handed back prepared (migrated and interned here, `prepareTile`: the page only files them); kept for the page even when the write failed.
          const answer: StreamTileAnswer = { key: tileKey(i, j), stored: ok ? version : null, ...(store.records ? { prepared: prepareTile(records) } : {}) };
          self.postMessage(answer);
        },
        (error: unknown) => self.postMessage({ i, j, error: `tile ${i},${j} was made and not stored: ${String(error)}` } satisfies StreamTileAnswer));
    } catch (error) {
      // Told and answered: the asker decides (`tileGenerator.ts`).
      console.error(`[city tile] tile ${i},${j} failed`, error);
      self.postMessage({ i, j, error: String(error) } satisfies StreamTileAnswer);
    }
  };
}
