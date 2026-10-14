import type { Building } from '@world/buildings/types';
import type { RoadDoc, SerializedDoc } from '@world/doc';

/**
 * A LARGE MAP SAVED IN PARTS. The autosave wrote the whole map as one text
 * (`Persistence.saveSession`); a city over the whole map is some 80 000
 * buildings and 600 MB of it, past the longest string the browser makes
 * (V8: about 512 MB) and minutes of writing for every edit. So a large map
 * is kept as parts in IndexedDB: its head (everything but the buildings),
 * and its buildings `BUILDINGS_PER_PART` ids a part, each part gzipped
 * (MDN, `CompressionStream`; records of the same kinds of keys and numbers
 * compress about tenfold), with a manifest naming them. A save writes only
 * the parts whose records changed - a record is never changed in place
 * (`BuildingStore.put` stores a copy), so a part whose records are the same
 * objects as last written is as written - and all of it in one transaction
 * (MDN, "Using IndexedDB": a transaction is all or nothing). No text of the
 * whole map is ever made, on saving or on loading.
 */

/** Buildings a part holds, by id. */
export const BUILDINGS_PER_PART = 512;
/** From this many buildings a map is saved in parts. */
export const PARTS_FROM_BUILDINGS = 3000;

/** Where a map's parts are kept: blobs by key, written and removed in one go. */
export interface PartStore {
  get(keys: readonly string[]): Promise<(Blob | null)[]>;
  /** Writes `put` and removes `remove` together; false when nothing was written. */
  write(put: readonly (readonly [string, Blob])[], remove: readonly string[]): Promise<boolean>;
}

/** What a parted save reads back. */
export interface PartedSession {
  readonly document: SerializedDoc;
  readonly settings: unknown;
  readonly savedAt: number;
}

interface Manifest {
  readonly version: 3;
  readonly savedAt: number;
  readonly parts: readonly number[];
  readonly settings: unknown;
}

const gzip = (text: string): Promise<Blob> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = (blob: Blob): Promise<string> =>
  new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m['version'] === 3 && typeof m['savedAt'] === 'number' && Array.isArray(m['parts'])
    && (m['parts'] as unknown[]).every((p) => Number.isInteger(p));
}

export class PartedSaves {
  /** The records each part held when last written. */
  private readonly written = new Map<number, readonly Building[]>();
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: PartStore, private readonly key: string) {}

  private partKey(part: number): string { return `${this.key}:part:${part}`; }

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    const byPart = new Map<number, Building[]>();
    for (const b of doc.buildings.all()) {
      const part = Math.floor(b.id / BUILDINGS_PER_PART);
      const list = byPart.get(part);
      if (list) list.push(b); else byPart.set(part, [b]);
    }
    const parts = [...byPart.keys()].sort((a, b) => a - b);
    const put: [string, Blob][] = [];
    const fresh = new Map<number, readonly Building[]>();
    for (const part of parts) {
      const records = byPart.get(part)!.sort((a, b) => a.id - b.id);
      const known = this.written.get(part);
      if (known && known.length === records.length && known.every((r, i) => r === records[i])) continue;
      // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip).
      put.push([this.partKey(part), await gzip(`[${records.map((b) => JSON.stringify(b)).join(',')}]`)]);
      fresh.set(part, records);
    }
    const remove = [...this.written.keys()].filter((part) => !byPart.has(part)).map((part) => this.partKey(part));
    put.push([`${this.key}:head`, await gzip(JSON.stringify(doc.withoutBuildings()))]);
    const manifest: Manifest = { version: 3, savedAt, parts, settings };
    put.push([`${this.key}:manifest`, new Blob([JSON.stringify(manifest)])]);
    if (!(await this.store.write(put, remove))) return false;
    for (const [part, records] of fresh) this.written.set(part, records);
    for (const part of [...this.written.keys()]) if (!byPart.has(part)) this.written.delete(part);
    return true;
  }

  /** The map saved in parts, or null when there is none or it cannot be read. */
  async read(): Promise<PartedSession | null> {
    const [manifestBlob] = await this.store.get([`${this.key}:manifest`]);
    if (!manifestBlob) return null;
    const manifest: unknown = JSON.parse(await manifestBlob.text());
    if (!isManifest(manifest)) return null;
    const blobs = await this.store.get([`${this.key}:head`, ...manifest.parts.map((part) => this.partKey(part))]);
    const [headBlob, ...partBlobs] = blobs;
    if (!headBlob || partBlobs.some((blob) => !blob)) return null;
    const head: unknown = JSON.parse(await gunzip(headBlob));
    if (typeof head !== 'object' || head === null) return null;
    const buildings: unknown[] = [];
    for (const blob of partBlobs) {
      const records: unknown = JSON.parse(await gunzip(blob!));
      if (!Array.isArray(records)) return null;
      for (const record of records) buildings.push(record);
    }
    return { document: { ...(head as SerializedDoc), buildings } as SerializedDoc, settings: manifest.settings, savedAt: manifest.savedAt };
  }

  /** Runs after the saves under way: never a removal in the middle of a write. */
  private queued(run: () => Promise<boolean>): Promise<boolean> {
    const done = this.queue.then(run);
    this.queue = done.catch((error: unknown) => { console.error('[save] the parts of the map were not reached', error); return false; });
    return done;
  }

  /** The keys the saved map is held under, the manifest last. */
  private async savedKeys(): Promise<string[]> {
    const [manifestBlob] = await this.store.get([`${this.key}:manifest`]);
    const manifest: unknown = manifestBlob ? JSON.parse(await manifestBlob.text()) : null;
    const parts = isManifest(manifest) ? manifest.parts.map((part) => this.partKey(part)) : [];
    return [`${this.key}:head`, ...parts, `${this.key}:manifest`];
  }

  /** The parts of the map removed: the map is saved whole again (`Persistence.saveSession`). */
  clear(): Promise<boolean> {
    return this.queued(async () => {
      this.written.clear();
      return this.store.write([], await this.savedKeys());
    });
  }

  /**
   * The map in parts set aside under a key of its own, never deleted: it
   * passed validation and the loader threw (`Persistence.quarantineStored`).
   * Copies and removal in one transaction.
   */
  setAside(at: number): Promise<boolean> {
    return this.queued(async () => {
      const keys = await this.savedKeys();
      const blobs = await this.store.get(keys);
      const aside = `${this.key}.unreadable.${at}`;
      const put = keys.flatMap((key, i) => {
        const blob = blobs[i];
        return blob ? [[`${aside}${key.slice(this.key.length)}`, blob] as const] : [];
      });
      if (put.length === 0) return false;
      this.written.clear();
      return this.store.write(put, keys);
    });
  }
}

/** A part store in an IndexedDB object store (`persistence.ts` opens the database). */
export function indexedDbParts(open: () => Promise<IDBDatabase | null>, storeName: string): PartStore {
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
    async get(keys) {
      const out = await transact('readonly', (store) => {
        const requests = keys.map((key) => store.get(key));
        return () => requests.map((r) => (r.result instanceof Blob ? r.result : null));
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
