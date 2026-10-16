/** THE TILE STORE AS A WORKER READS IT ITSELF (CLAUDE.md "Streaming world"): installed by the job worker (`job.worker.ts`, `tileReader.ts`), read by the bakes of the far levels, so a tile's records never cross the page to reach them */

/** A stored tile's records (`world/doc.ts` TileRecords), or null when the store has none. */
type Read = (map: string, key: number) => Promise<unknown>;

let reader: Read | null = null;

/** The store's reader of this thread: set where the store can be opened (a worker of the browser's IndexedDB), never on the page. */
export function readStoredTilesWith(read: Read): void {
  reader = read;
}

/** This thread's reader of the store; null where none was installed (the page, the tests, the desktop's store in the main process). */
export function storedTileReader(): Read | null {
  return reader;
}
