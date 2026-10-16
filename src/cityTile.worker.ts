import { buildStreamTile } from '@editor/wholeMapTile';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { type TileRecords, tileKey } from '@world/tiles';
import type { JobScope } from './jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): one tile of the streamed world built off the page (`editor/wholeMapTile.ts`, `world/tiles.ts`), asked for by `tileGenerator.ts`. */

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk {
  readonly stream: true;
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
}

/** The streamed tile built (its key and records), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords } | { readonly i: number; readonly j: number; readonly error: string };

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<StreamTileAsk>) => {
    const { options, i, j } = event.data;
    try {
      self.postMessage({ key: tileKey(i, j), records: buildStreamTile(options, i, j) } satisfies StreamTileAnswer);
    } catch (error) {
      // Told and answered: the asker decides (`tileGenerator.ts`).
      console.error(`[city tile] tile ${i},${j} failed`, error);
      self.postMessage({ i, j, error: String(error) } satisfies StreamTileAnswer);
    }
  };
}
