import type { JobScope } from '../jobs/jobScope';
import type { TileOp } from './tileStore';

/** THE AUTOSAVE'S WRITER: the text, the compression and the IndexedDB write of what the page found changed, off the page */

/** Where a map's blobs are kept: blobs by key, written and removed in one go. */
export interface PartStore {
  get(keys: readonly string[]): Promise<(Blob | null)[]>;
  /** Writes `put` and removes `remove` together; false when nothing was written. */
  write(put: readonly (readonly [string, Blob])[], remove: readonly string[]): Promise<boolean>;
  /** Who encodes and writes a save for this store (a worker); absent: done where it is asked. */
  readonly writer?: SaveWriter;
}

/** One blob of a save: its key and its value as plain data, compressed (`packed`) or plain JSON. */
export interface SaveEntry { readonly key: string; readonly value: unknown; readonly packed: boolean }
/** What one save writes and removes, in one transaction: the records of what changed, never the map. */
export interface SaveBatch { readonly put: readonly SaveEntry[]; readonly remove: readonly string[] }
/** Writes a save's batch, true once it is stored. */
export interface SaveWriter { write(batch: SaveBatch): Promise<boolean> }

/** gzip streams (MDN, `CompressionStream`): in every browser the game runs in and in Node 18+. */
export const gzip = (text: string): Promise<Blob> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
export const gunzip = (blob: Blob): Promise<string> =>
  new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

/** The batch made text and blobs and written to `store` in one transaction. */
export async function writeBatch(store: PartStore, batch: SaveBatch): Promise<boolean> {
  const put: [string, Blob][] = [];
  for (const entry of batch.put) {
    const text = JSON.stringify(entry.value);
    put.push([entry.key, entry.packed ? await gzip(text) : new Blob([text])]);
  }
  return store.write(put, batch.remove);
}

/** Encodes and writes in the thread that asks (the tests, a store without a worker). */
export const storeWriter = (store: PartStore): SaveWriter => ({ write: (batch) => writeBatch(store, batch) });

/** Encodes and writes in the job system's `save` lane (`port`): the page only hands it the changed records. */
export function portWriter(port: () => Worker): SaveWriter {
  let worker: Worker | null = null;
  let next = 1;
  const waiting = new Map<number, (ok: boolean) => void>();
  const failAll = (): void => { for (const done of waiting.values()) done(false); waiting.clear(); };
  return {
    write(batch) {
      if (!worker) {
        worker = port();
        worker.onmessage = (event: MessageEvent<{ readonly id: number; readonly ok: boolean }>) => {
          const done = waiting.get(event.data.id);
          waiting.delete(event.data.id);
          done?.(event.data.ok);
        };
        worker.onerror = failAll;
        worker.onmessageerror = failAll;
      }
      const id = next++;
      return new Promise<boolean>((resolve) => {
        waiting.set(id, resolve);
        try { worker!.postMessage({ id, batch }); } catch (error) { waiting.delete(id); console.error('[save] the save could not reach its worker', error); resolve(false); }
      });
    },
  };
}

/** The IndexedDB database and store of the large autosaves (the page's `persistence.ts` and this worker open the same one). */
const SAVES_DB = 'roadcraft-saves';
export const SAVES_STORE = 'sessions';
let savesDb: Promise<IDBDatabase | null> | null = null;
/** The large autosaves' database; null where IndexedDB is missing or refused. */
export function openSaves(): Promise<IDBDatabase | null> {
  savesDb ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const request = indexedDB.open(SAVES_DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(SAVES_STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return savesDb;
}

/** A part store in an IndexedDB object store. */
export function indexedDbParts(open: () => Promise<IDBDatabase | null>, storeName: string, writer?: SaveWriter): PartStore {
  const transact = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T | null> => {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const result = run(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result());
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (error) {
        console.error('[save] the parts of the map could not be reached', error);
        resolve(null);
      }
    });
  };
  return {
    ...(writer ? { writer } : {}),
    async get(keys) {
      const out = await transact('readonly', (store) => {
        const requests = keys.map((key) => store.get(key));
        // A text (the whole-map save `persistence.ts` keeps under the map's own key) handed on as a blob, for the tile store's migration.
        return () => requests.map((r) => (r.result instanceof Blob ? r.result : typeof r.result === 'string' ? new Blob([r.result]) : null));
      });
      return out ?? keys.map(() => null);
    },
    async write(put, remove) {
      const out = await transact('readwrite', (store) => {
        for (const [key, blob] of put) store.put(blob, key);
        for (const key of remove) store.delete(key);
        return () => true;
      });
      return out === true;
    },
  };
}

/** What the page asks of this service: a save's batch, or a call of the tile store (`tileStore.ts`). */
type SaveMessage = { readonly id: number; readonly batch: SaveBatch } | { readonly id: number; readonly tiles: TileOp };

/** This service of the job system (`jobs/job.worker.ts`): each batch encoded and written, each tile call run, answered by its id. */
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
