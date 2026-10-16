import { buildStreamTilePair } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import type { JobScope } from './jobs/jobScope';
import { workerParts } from '@editor/workerParts';
import { type PreparedTile, prepareTile, writeTile } from '@editor/tileStore';
import { bakeTileSections } from '@sim/tileSections';

/** This service of the job system (`job.worker.ts`): one tile of the streamed world built off the page (`editor/wholeMapTile.ts`, `world/tiles.ts`), asked for by `tileGenerator.ts`. */

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
  /** Stored here in the tile store's map (`workerParts`) at a version past `after`: the page never posts a tile it was handed back to the store; `records`, its records handed back prepared too (a tile of the region, `prepareTile`), else its version alone (a tile made ahead). */
  readonly store?: { readonly map: string; readonly after: number; readonly records: boolean };
}

/** The streamed tile built (its key and records), stored here (its version, and its records prepared when asked for), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords } | { readonly key: number; readonly stored: number | null; readonly prepared?: PreparedTile }
  | { readonly i: number; readonly j: number; readonly error: string };

/** The tile store's parts as this worker opens them (`workerParts`: IndexedDB, or the desktop's saves writer through its own port), on the first tile stored. */
let parts: ReturnType<typeof workerParts> | null = null;
const stored = (): ReturnType<typeof workerParts> => (parts ??= workerParts());

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { options, i, j, store } = event.data;
    try {
      // Stored with its grown buildings as rows (`world/growth/rows.ts`); baked and handed to the page whole, as just grown (never made again here).
      const pair = buildStreamTilePair(options, i, j);
      if (!store) { self.postMessage({ key: tileKey(i, j), records: pair.records } satisfies StreamTileAnswer); return; }
      const version = Math.max(pair.records.version, store.after) + 1;
      const records = { ...pair.records, version }, full = { ...pair.full, version };
      // Its sections baked here with it, once (`sim/tileSections.ts`).
      void writeTile(stored(), store.map, records, bakeTileSections, full).then(
        ({ ok }) => {
          // The records handed back prepared (migrated and interned here, `prepareTile`: the page only files them); kept for the page even when the write failed.
          const answer: StreamTileAnswer = { key: tileKey(i, j), stored: ok ? version : null, ...(store.records ? { prepared: prepareTile(full) } : {}) };
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
