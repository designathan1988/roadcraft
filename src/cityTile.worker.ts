import { buildTile } from '@editor/wholeMapTile';
import type { TilePiece } from '@world/cityGen/assemble';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import type { JobScope } from './jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): one tile of the whole map built off the page (`editor/wholeMapTile.ts`), asked for by `wholeMapRun.ts`. */

/** A tile asked for. */
export interface TileAsk {
  readonly options: WholeMapOptions;
  readonly i: number;
  readonly j: number;
}

/** The tile built, or why it could not be. */
export type TileAnswer = { readonly piece: TilePiece } | { readonly i: number; readonly j: number; readonly error: string };

export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<TileAsk>) => {
    const { options, i, j } = event.data;
    try {
      self.postMessage({ piece: buildTile(options, i, j) } satisfies TileAnswer);
    } catch (error) {
      // Told and answered: the page gives the whole map up (`wholeMapRun.ts`).
      console.error(`[whole map] tile ${i},${j} failed`, error);
      self.postMessage({ i, j, error: String(error) } satisfies TileAnswer);
    }
  };
}
