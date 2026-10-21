import { gzipBytes } from './saveBinary';

/** THE SAVES' STORE (IndexedDB) AND ITS BATCHES: what the save worker runs (`save.worker.ts`) and what the map by tiles and the tile store write through (`chunkedSave.ts`, `tileStore.ts`) - apart from the worker, so neither imports the other */

/** Where a map's blobs are kept: blobs by key, written and removed in one go. */
export interface PartStore {
  get(keys: readonly string[]): Promise<(Blob | null)[]>;
  /** Writes `put` and removes `remove` together, with `marks` (short texts, `marks`); false when nothing was written. */
  write(put: readonly (readonly [string, Blob])[], remove: readonly string[], marks?: readonly (readonly [string, string])[]): Promise<boolean>;
  /** Every mark whose key starts with `prefix`, in one read: what a world's every tile is known by (`tileBlob.ts` tileMarkKey); absent: the store keeps none, each tile is asked. */
  marks?(prefix: string): Promise<readonly (readonly [string, string])[]>;
  /** Who encodes and writes a save for this store (a worker); absent: done where it is asked. */
  readonly writer?: SaveWriter;
}

/** One blob of a save: its key and its binary frame (`saveBinary.ts`), compressed by the writer when `packed`. A plain ArrayBuffer, transferred to the writer, never copied (MDN "Transferable objects"). */
export interface SaveEntry { readonly key: string; readonly bytes: ArrayBuffer; readonly packed: boolean }
/** What one save writes and removes, in one transaction: the frames of what changed, never the map. */
export interface SaveBatch { readonly put: readonly SaveEntry[]; readonly remove: readonly string[] }
/** The buffers a batch carries: the transfer list of its message. */
export const batchBuffers = (batch: SaveBatch): ArrayBuffer[] => batch.put.map((entry) => entry.bytes);
/** Writes a save's batch, true once it is stored. */
export interface SaveWriter { write(batch: SaveBatch): Promise<boolean> }

/** gzip streams (MDN, `CompressionStream`): the texts of the saves before the binary frames (read, never written now). */
export const gzip = (text: string): Promise<Blob> =>
  typeof CompressionStream === 'undefined'
    ? Promise.resolve(new Blob([text]))
    : new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
export const gunzip = (blob: Blob): Promise<string> =>
  typeof DecompressionStream === 'undefined'
    ? blob.text()
    : new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

/** How many frames are compressed at once. */
const GZIP_BATCH = 32;

/** The batch's frames compressed (`packed`) and written to `store` in one transaction: no text made here. */
export async function writeBatch(store: PartStore, batch: SaveBatch): Promise<boolean> {
  const put: [string, Blob][] = [];
  // A batch of streams in flight at a time: a whole map's first save is thousands of frames.
  for (let i = 0; i < batch.put.length; i += GZIP_BATCH) {
    const some = batch.put.slice(i, i + GZIP_BATCH);
    put.push(...await Promise.all(some.map(async (entry) => [entry.key, entry.packed ? await gzipBytes(entry.bytes) : new Blob([entry.bytes])] as [string, Blob])));
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
        try { worker!.postMessage({ id, batch }, batchBuffers(batch)); } catch (error) { waiting.delete(id); console.error('[save] the save could not reach its worker', error); resolve(false); }
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
    } catch (error) {
      console.error('[save] the saves database could not be opened', error);
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
    async write(put, remove, marks) {
      const out = await transact('readwrite', (store) => {
        for (const [key, blob] of put) store.put(blob, key);
        // A mark as a string, not a blob: DO NOT give each a blob of its own (a file each in Chromium's IndexedDB), the world's marks read at once (`marks`).
        for (const [key, text] of marks ?? []) store.put(text, key);
        for (const key of remove) store.delete(key);
        return () => true;
      });
      return out === true;
    },
    async marks(prefix) {
      // One transaction, the keys and values of one key range (MDN IDBObjectStore getAll, getAllKeys; IDBKeyRange.bound).
      const out = await transact('readonly', (store) => {
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        const keys = store.getAllKeys(range);
        const values = store.getAll(range);
        return () => {
          const found: [string, string][] = [];
          keys.result.forEach((key, k) => { const value: unknown = values.result[k]; if (typeof key === 'string' && typeof value === 'string') found.push([key, value]); });
          return found;
        };
      });
      return out ?? [];
    },
  };
}

/** What the page asks of this service: a save's batch, or a call of the tile store (`tileStore.ts`). */
