import type { Building, BuildingId } from '@world/buildings/types';
import { DOC_CHANGE_KINDS } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc, SerializedDoc } from '@world/doc';

/**
 * THE MAP SAVED IN PARTS. The autosave wrote the whole map as one text
 * (`Persistence.saveSession`); a city over the whole map is some 80 000
 * buildings and 600 MB of it, past the longest string the browser makes
 * (V8: about 512 MB) and minutes of writing for every edit. So the map is kept
 * as parts in IndexedDB: its head (everything but the buildings), and its
 * buildings `BUILDINGS_PER_PART` ids a part, each part gzipped (MDN,
 * `CompressionStream`; records of the same kinds of keys and numbers compress
 * about tenfold), with a manifest naming them, all of a save in one
 * transaction (MDN, "Using IndexedDB": a transaction is all or nothing).
 *
 * A save writes what the diary (`world/derived.ts` `JournalCursor`) says
 * changed since the last save that was written: the parts of the buildings it
 * names (`buildings`, `buildingWear`, by id), and the head only when a kind of
 * the head changed. The first save of a map, a document swapped or a diary
 * that forgot writes every part once. No text of the whole map is ever made,
 * on saving or on loading.
 * DO NOT walk every building of the map to find the parts that changed, nor
 * write the head on every save: a building grown wrote the roads, the lots and
 * the trees of the whole city again and compared every record of it.
 */

/** Buildings a part holds, by id. */
export const BUILDINGS_PER_PART = 512;
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

/** The kinds that live in the buildings' parts; every other kind of the document is in the head. */
const BUILDING_KINDS: ReadonlySet<string> = new Set(['buildings', 'buildingWear']);

export class PartedSaves {
  /** The diary read up to the last save (every kind of the document). */
  private readonly cursor = new JournalCursor(DOC_CHANGE_KINDS);
  /** The document the stored parts are of; another one is written whole. */
  private doc: RoadDoc | null = null;
  /** The parts stored now (the manifest's list). */
  private readonly stored = new Set<number>();
  /** What changed and is not yet written (kept across a failed write): the parts, or all; the head. */
  private dirtyParts: Set<number> | 'all' = 'all';
  private dirtyHead = true;
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: PartStore, private readonly key: string) {}

  private partKey(part: number): string { return `${this.key}:part:${part}`; }

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  /**
   * The document just opened from these parts (`Persistence.adoptLoaded`):
   * what is stored is this document, so the next save writes only what
   * changes after now, not every part again.
   */
  adopt(doc: RoadDoc, parts: readonly number[]): void {
    this.doc = doc;
    this.cursor.read(doc.changes);
    this.stored.clear();
    for (const part of parts) this.stored.add(part);
    this.dirtyParts = new Set();
    this.dirtyHead = false;
  }

  /** Nothing is known to be stored: the next save writes every part. */
  private forget(): void {
    this.doc = null;
    this.stored.clear();
    this.dirtyParts = 'all';
    this.dirtyHead = true;
  }

  /** What the diary says changed since the last look, added to what waits to be written. */
  private take(doc: RoadDoc): void {
    const entries = this.doc === doc ? this.cursor.read(doc.changes) : null;
    if (entries === null) {
      this.cursor.read(doc.changes);
      this.doc = doc;
      this.dirtyParts = 'all';
      this.dirtyHead = true;
      return;
    }
    for (const entry of entries) {
      if (!BUILDING_KINDS.has(entry.kind)) { this.dirtyHead = true; continue; }
      if (this.dirtyParts === 'all') continue;
      if (!entry.ids) { this.dirtyParts = 'all'; continue; }
      for (const id of entry.ids) this.dirtyParts.add(Math.floor(id / BUILDINGS_PER_PART));
    }
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    this.take(doc);
    const dirty = this.dirtyParts;
    const whole = dirty === 'all';
    const parts = dirty === 'all' ? everyPart(doc) : new Map([...dirty].map((part) => [part, recordsOf(doc, part)] as const));
    const head = this.dirtyHead;
    // Taken now; put back if the write fails (and with whatever came meanwhile).
    this.dirtyParts = new Set();
    this.dirtyHead = false;
    const put: [string, Blob][] = [];
    const remove: string[] = [];
    const next = new Set(whole ? [] : this.stored);
    for (const [part, records] of parts) {
      if (records.length === 0) {
        next.delete(part);
        if (this.stored.has(part)) remove.push(this.partKey(part));
        continue;
      }
      // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip).
      put.push([this.partKey(part), await gzip(`[${records.map((b) => JSON.stringify(b)).join(',')}]`)]);
      next.add(part);
    }
    if (whole) for (const part of this.stored) if (!next.has(part)) remove.push(this.partKey(part));
    if (head) put.push([`${this.key}:head`, await gzip(JSON.stringify(doc.withoutBuildings()))]);
    const manifest: Manifest = { version: 3, savedAt, parts: [...next].sort((a, b) => a - b), settings };
    put.push([`${this.key}:manifest`, new Blob([JSON.stringify(manifest)])]);
    if (!(await this.store.write(put, remove))) {
      const since = this.dirtyParts;
      this.dirtyParts = dirty === 'all' || since === 'all' ? 'all' : new Set([...dirty, ...since]);
      this.dirtyHead ||= head;
      return false;
    }
    this.stored.clear();
    for (const part of next) this.stored.add(part);
    return true;
  }

  /** The map saved in parts, or null when there is none or it cannot be read. */
  async read(): Promise<(PartedSession & { readonly parts: readonly number[] }) | null> {
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
    return { document: { ...(head as SerializedDoc), buildings } as SerializedDoc, settings: manifest.settings, savedAt: manifest.savedAt, parts: manifest.parts };
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
      this.forget();
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
      this.forget();
      return this.store.write(put, keys);
    });
  }
}

/** The buildings of one part, by id: the ids of its range looked up, never the whole store. */
function recordsOf(doc: RoadDoc, part: number): Building[] {
  const out: Building[] = [];
  for (let id = part * BUILDINGS_PER_PART; id < (part + 1) * BUILDINGS_PER_PART; id++) {
    const b = doc.buildings.get(id as BuildingId);
    if (b) out.push(b);
  }
  return out;
}

/** @rebuild The first save of a map (or the diary cannot say): every building, by part. */
function everyPart(doc: RoadDoc): Map<number, Building[]> {
  const byPart = new Map<number, Building[]>();
  for (const b of doc.buildings.all()) {
    const part = Math.floor(b.id / BUILDINGS_PER_PART);
    const list = byPart.get(part);
    if (list) list.push(b); else byPart.set(part, [b]);
  }
  for (const list of byPart.values()) list.sort((a, b) => a.id - b.id);
  return byPart;
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
