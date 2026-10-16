import { buildStreamTile, buildTile } from '@editor/wholeMapTile';
import type { TilePiece } from '@world/cityGen/assemble';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { type TileRecords, tileKey } from '@world/tiles';
import type { JobScope } from './jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): one tile built off the page (`editor/wholeMapTile.ts`) - a piece of the fixed whole map (its tests, `assemble.ts`), or a tile of the streamed world (`world/tiles.ts`), asked for with `stream`. */

/** A tile of the fixed whole map asked for. */
export interface TileAsk {
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
}

/** A tile of the streamed world asked for: built as the tile store keeps it. */
export interface StreamTileAsk extends TileAsk {
  readonly stream: true;
}

/** The tile built, or why it could not be. */
export type TileAnswer = { readonly piece: TilePiece } | { readonly i: number; readonly j: number; readonly error: string };

/** The streamed tile built (its key and records), or why it could not be. */
export type StreamTileAnswer = { readonly key: number; readonly records: TileRecords } | { readonly i: number; readonly j: number; readonly error: string };

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<TileAsk | StreamTileAsk>) => {
    const ask = event.data;
    const { options, i, j } = ask;
    try {
      if ('stream' in ask && ask.stream) self.postMessage({ key: tileKey(i, j), records: buildStreamTile(options, i, j) } satisfies StreamTileAnswer);
      else self.postMessage({ piece: buildTile(options, i, j) } satisfies TileAnswer);
    } catch (error) {
      // Told and answered (the same failure for both asks): a streamed tile's asker decides.
      console.error(`[city tile] tile ${i},${j} failed`, error);
      self.postMessage({ i, j, error: String(error) } satisfies TileAnswer);
    }
  };
}
