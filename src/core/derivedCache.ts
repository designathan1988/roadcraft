/** DERIVED DATA kept in the player's browser: what the game makes from its own code the same way every time */
const DB = 'roadcraft-derived';
const STORE = 'entries';
/** DO NOT wait for the disk on a derived write (MDN IDBDatabase.transaction, `durability: 'relaxed'`): what is kept here is made again if lost, and each commit held a tile's maker lane while the store caught up (the opening's workers at half load, 2026-10-17). The player's saves and the tiles (`editor/saveStore.ts`) keep the default. */
const RELAXED: IDBTransactionOptions = Object.freeze({ durability: 'relaxed' });

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    // DO NOT keep it: closed for another tab's upgrade, every transaction on it threw
    const forget = (): void => { opening = null; };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab of a newer build asks to upgrade: let it.
      db.onversionchange = () => { db.close(); forget(); };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => { forget(); resolve(null); };
    request.onblocked = () => { forget(); resolve(null); };
  });
  return opening;
}

/** Whether the store opens here (none in Node, refused in some private windows): what is kept can be read back. */
export async function derivedCacheOpen(): Promise<boolean> {
  return (await database()) !== null;
}

/** The keys from `prefix` up to every key that starts with it. */
const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`);

/** One entry, or undefined when it is not kept. */
export async function readDerived<T>(key: string): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** The keys that start with `prefix`, without it: what is kept, never the values (a store that grows with the places visited). */
export async function readDerivedKeys(prefix: string): Promise<Set<string>> {
  const out = new Set<string>();
  const db = await database();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const keys = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(prefixRange(prefix));
      keys.onsuccess = () => { for (const key of keys.result ?? []) out.add(String(key).slice(prefix.length)); resolve(out); };
      keys.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** The entries of these keys (under `prefix`), in one transaction: only what a build will use. */
export async function readDerivedSome<T>(prefix: string, keys: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await database();
  if (!db || !keys.length) return out;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      for (const key of keys) {
        const request = store.get(prefix + key);
        request.onsuccess = () => { if (request.result !== undefined) out.set(key, request.result as T); };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
      tx.onabort = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** Every entry whose key starts with `prefix`, by the rest of its key. */
export async function readDerivedAll<T>(prefix: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await database();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const keys = store.getAllKeys(prefixRange(prefix));
      const values = store.getAll(prefixRange(prefix));
      values.onsuccess = () => {
        const list = keys.result ?? [];
        list.forEach((key, i) => out.set(String(key).slice(prefix.length), values.result[i] as T));
        resolve(out);
      };
      values.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** Keeps a value under `key`. */
async function keepDerived(key: string, value: unknown): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite', RELAXED);
    const request = tx.objectStore(STORE).put(value, key);
    request.onerror = (event) => event.preventDefault();
  } catch {
    // Not kept (no space, private window): made again next time.
  }
}

/** As `keepDerived`, and also tells when the write has committed (the transaction's `complete`, MDN) or failed */
export async function keepDerivedDurably(key: string, value: unknown): Promise<{ committed: Promise<void> }> {
  const db = await database();
  if (!db) return { committed: Promise.resolve() };
  try {
    const tx = db.transaction(STORE, 'readwrite', RELAXED);
    const committed = new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });
    const request = tx.objectStore(STORE).put(value, key);
    request.onerror = (event) => event.preventDefault();
    return { committed };
  } catch {
    return { committed: Promise.resolve() };
  }
}

/** Keeps `entries` in one transaction, resolved once the write is queued, not committed: a read asked after it, from any thread, sees it (IndexedDB starts a read-only transaction only once the read/write transactions created before it on its store are finished, W3C IndexedDB "transaction scheduling"); DO NOT wait for the commit where nothing needs it (a tile's maker held its lane 5-8 s a tile for it, 2026-10-16), nor queue without bound (`budget`, the V8 cage), nor commit a tile's far levels key by key (its masses, its plate, its boxes, its roads: four commits a tile, the generator's lanes waiting on them, 2026-10-17). Resolved once queued; the budget freed on the commit. */
export async function keepDerivedQueuedMany(entries: readonly (readonly [string, unknown])[], budget: WriteBudget): Promise<void> {
  if (!entries.length) return;
  let bytes = 0;
  for (const [, value] of entries) bytes += bytesOf(value);
  const release = await budget.take(bytes);
  const db = await database();
  if (!db) { release(); return; }
  try {
    const tx = db.transaction(STORE, 'readwrite', RELAXED);
    tx.oncomplete = release;
    tx.onabort = release;
    tx.onerror = release;
    const store = tx.objectStore(STORE);
    for (const [key, value] of entries) {
      const request = store.put(value, key);
      request.onerror = (event) => event.preventDefault();
    }
  } catch (error) {
    release();
    // Not kept (no space, private window): its far jobs bake it again.
    console.error('[derived] a tile\'s far levels were not kept', error);
  }
}

/** THE BYTES OF WRITES A THREAD HAS HANDED INDEXEDDB AND NOT SEEN COMMITTED, held under `most` (the V8 cage, the defect that kills the runs): one per thread that writes the derived cache, made where its service is served (`cityTile.worker.ts`, `renderer.ts`). */
export class WriteBudget {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(readonly most: number) {}

  /** Bytes in flight now. */
  get bytes(): number {
    return this.inFlight;
  }

  /** Room for `bytes`, once the writes in flight leave it (at once for a write alone, whatever its size): the release to call on its commit. */
  async take(bytes: number): Promise<() => void> {
    while (this.inFlight > 0 && this.inFlight + bytes > this.most) await new Promise<void>((go) => this.waiting.push(go));
    return this.taken(bytes);
  }

  /** Room for `bytes` now, or null: for a thread that may not wait (the page), what does not fit is not kept (made again next time). */
  tryTake(bytes: number): (() => void) | null {
    if (this.inFlight > 0 && this.inFlight + bytes > this.most) return null;
    return this.taken(bytes);
  }

  private taken(bytes: number): () => void {
    this.inFlight += bytes;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.inFlight -= bytes;
      for (const go of this.waiting.splice(0)) go();
    };
  }
}

/** About how many bytes a value takes once cloned (its arrays' buffers, its strings, a number's eight): what a write holds until it commits. */
export function bytesOf(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object' || depth > 8) return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  let total = 0;
  if (value instanceof Map) { for (const [k, v] of value) total += bytesOf(k, depth + 1) + bytesOf(v, depth + 1); return total; }
  if (Array.isArray(value)) { for (const v of value) total += bytesOf(v, depth + 1); return total; }
  for (const v of Object.values(value)) total += bytesOf(v, depth + 1);
  return total;
}

/** Keeps a value under `key`, without waiting. */
export function writeDerived(key: string, value: unknown): void {
  void keepDerived(key, value);
}

/** Keeps many values, each under `prefix` and its own key, in one transaction */
export function writeDerivedMany(prefix: string, values: ReadonlyMap<string, unknown>): void {
  void keepDerivedMany(prefix, values);
}

/** As `keepDerivedMany`, resolved once the transaction has committed (or failed): what the derived writer answers on (`derivedWriter.worker.ts`). */
export async function keepDerivedManyCommitted(prefix: string, values: ReadonlyMap<string, unknown>): Promise<void> {
  if (!values.size) return;
  const db = await database();
  if (!db) return;
  // A transaction that cannot be made (no space, the store closed) throws to the writer, which says so (`derivedWriter.worker.ts`).
  const tx = db.transaction(STORE, 'readwrite', RELAXED);
  const committed = new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); tx.onabort = () => resolve(); tx.onerror = () => resolve(); });
  const store = tx.objectStore(STORE);
  for (const [key, value] of values) {
    const request = store.put(value, `${prefix}${key}`);
    request.onerror = (event) => event.preventDefault();
  }
  await committed;
}

/** As `writeDerivedMany`, resolved once the store has taken its copy of every value */
export async function keepDerivedMany(prefix: string, values: ReadonlyMap<string, unknown>): Promise<void> {
  if (!values.size) return;
  const db = await database();
  if (!db) return;
  try {
    const store = db.transaction(STORE, 'readwrite', RELAXED).objectStore(STORE);
    for (const [key, value] of values) {
      const request = store.put(value, `${prefix}${key}`);
      request.onerror = (event) => event.preventDefault();
    }
  } catch {
    // Not kept (no space, private window): made again next time.
  }
}

/** Forgets these entries (each `prefix` + key), without waiting: one readwrite transaction, a `delete` per key */
export function forgetDerivedKeys(prefix: string, keys: Iterable<string>): void {
  const list = [...keys];
  if (!list.length) return;
  void database().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, 'readwrite', RELAXED).objectStore(STORE);
      for (const key of list) {
        const request = store.delete(`${prefix}${key}`);
        request.onerror = (event) => event.preventDefault();
      }
    } catch {
      // Left for another time.
    }
  });
}

/** Forgets the entries of `kind` kept under any other fingerprint (an older build's). */
export function forgetOtherDerived(kind: string, fingerprint: string): void {
  void database().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, 'readwrite', RELAXED).objectStore(STORE);
      const keep = `${kind}:${fingerprint}:`;
      const request = store.getAllKeys(prefixRange(`${kind}:`));
      request.onsuccess = () => {
        for (const key of request.result) if (!String(key).startsWith(keep)) store.delete(key);
      };
    } catch {
      // Left for another time.
    }
  });
}
