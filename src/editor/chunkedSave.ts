import type { Building, BuildingId } from '@world/buildings/types';
import { type ChangeKind, DOC_CHANGE_KINDS } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc, SerializedDoc } from '@world/doc';

/** DO NOT walk every building of the map to find the parts that changed, nor write the head on every save */

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
const BUILDING_KINDS: readonly ChangeKind[] = ['buildings', 'buildingWear'];

export class PartedSaves {
  /** The diary read up to the last save (every kind of the document). */
  private readonly cursor = new JournalCursor(DOC_CHANGE_KINDS);
  /** The document the stored parts are of; another one is written whole. */
  private doc: RoadDoc | null = null;
  /** The parts stored now (the manifest's list). */
  private readonly stored = new Set<number>();
  /** What changed and is not yet written (kept across a failed write): the parts, or all; the head. */
  private dirtyParts: Set<number> | 'all' = 'all';
  /** The parts whose buildings' wear changed and is not yet written (their records may not have). */
  private dirtyWear: Set<number> | 'all' = 'all';
  private dirtyHead = true;
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: PartStore, private readonly key: string) {}

  private partKey(part: number): string { return `${this.key}:part:${part}`; }
  private wearKey(part: number): string { return `${this.key}:wear:${part}`; }

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  /** The document just opened from these parts (`Persistence.adoptLoaded`) */
  adopt(doc: RoadDoc, parts: readonly number[]): void {
    this.doc = doc;
    this.cursor.read(doc.changes);
    this.stored.clear();
    for (const part of parts) this.stored.add(part);
    this.dirtyParts = new Set();
    this.dirtyWear = new Set();
    this.dirtyHead = false;
  }

  /** Nothing is known to be stored: the next save writes every part. */
  private forget(): void {
    this.doc = null;
    this.stored.clear();
    this.dirtyParts = 'all';
    this.dirtyWear = 'all';
    this.dirtyHead = true;
  }

  /** What the diary says changed since the last look, added to what waits to be written. */
  private take(doc: RoadDoc): void {
    const entries = this.doc === doc ? this.cursor.read(doc.changes) : null;
    if (entries === null) {
      this.cursor.read(doc.changes);
      this.doc = doc;
      this.dirtyParts = 'all';
      this.dirtyWear = 'all';
      this.dirtyHead = true;
      return;
    }
    for (const entry of entries) {
      if (!BUILDING_KINDS.includes(entry.kind)) { this.dirtyHead = true; continue; }
      // Wear alone: the part's wears; anything else of a building: its part's records (and wears).
      const wearOnly = entry.kind === 'buildingWear';
      if (!entry.ids) { this.dirtyWear = 'all'; if (!wearOnly) this.dirtyParts = 'all'; continue; }
      for (const id of entry.ids) {
        const part = Math.floor(id / BUILDINGS_PER_PART);
        if (this.dirtyWear !== 'all') this.dirtyWear.add(part);
        if (!wearOnly && this.dirtyParts !== 'all') this.dirtyParts.add(part);
      }
    }
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    this.take(doc);
    const dirty = this.dirtyParts;
    const whole = dirty === 'all';
    const parts = dirty === 'all' ? everyPart(doc) : new Map([...dirty].map((part) => [part, recordsOf(doc, part)] as const));
    // The stored parts whose wears alone are written: their records stand as stored.
    const wornDirty = this.dirtyWear;
    const worn = new Map<number, Building[]>();
    if (!whole) {
      const wornParts = wornDirty === 'all' ? [...this.stored] : [...wornDirty];
      for (const part of wornParts) if (!parts.has(part) && this.stored.has(part)) worn.set(part, recordsOf(doc, part));
    }
    const head = this.dirtyHead;
    // Taken now; put back if the write fails (and with whatever came meanwhile).
    this.dirtyParts = new Set();
    this.dirtyWear = new Set();
    this.dirtyHead = false;
    const put: [string, Blob][] = [];
    const remove: string[] = [];
    const next = new Set(whole ? [] : this.stored);
    for (const [part, records] of parts) {
      if (records.length === 0) {
        next.delete(part);
        if (this.stored.has(part)) remove.push(this.partKey(part), this.wearKey(part));
        continue;
      }
      // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip).
      put.push([this.partKey(part), await gzip(`[${records.map((b) => JSON.stringify(b)).join(',')}]`)]);
      put.push([this.wearKey(part), wearsOf(records)]);
      next.add(part);
    }
    // A stored part with no building left is a change of its records (`buildings`), never of wear alone.
    for (const [part, records] of worn) if (records.length) put.push([this.wearKey(part), wearsOf(records)]);
    if (whole) for (const part of this.stored) if (!next.has(part)) remove.push(this.partKey(part), this.wearKey(part));
    if (head) put.push([`${this.key}:head`, await gzip(JSON.stringify(doc.withoutBuildings()))]);
    const manifest: Manifest = { version: 3, savedAt, parts: [...next].sort((a, b) => a - b), settings };
    put.push([`${this.key}:manifest`, new Blob([JSON.stringify(manifest)])]);
    if (!(await this.store.write(put, remove))) {
      // Read again: what came while the write was under way (TS keeps the narrowing across the await).
      const since = this.dirtyParts as Set<number> | 'all';
      this.dirtyParts = dirty === 'all' || since === 'all' ? 'all' : new Set([...dirty, ...since]);
      const wornSince = this.dirtyWear as Set<number> | 'all';
      this.dirtyWear = wornDirty === 'all' || wornSince === 'all' ? 'all' : new Set([...wornDirty, ...wornSince]);
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
    // Each part's wears, where kept (a map saved before them has none: its records carry their wear).
    const wearBlobs = await this.store.get(manifest.parts.map((part) => this.wearKey(part)));
    const head: unknown = JSON.parse(await gunzip(headBlob));
    if (typeof head !== 'object' || head === null) return null;
    const buildings: unknown[] = [];
    for (let i = 0; i < partBlobs.length; i++) {
      const records: unknown = JSON.parse(await gunzip(partBlobs[i]!));
      if (!Array.isArray(records)) return null;
      const wearBlob = wearBlobs[i];
      const wears = wearBlob ? readWears(await wearBlob.text()) : null;
      for (const record of records) buildings.push(wears ? withWear(record, wears) : record);
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
    const parts = isManifest(manifest) ? manifest.parts.flatMap((part) => [this.partKey(part), this.wearKey(part)]) : [];
    return [`${this.key}:head`, ...parts, `${this.key}:manifest`];
  }

  /** The parts of the map removed: the map is saved whole again (`Persistence.saveSession`). */
  clear(): Promise<boolean> {
    return this.queued(async () => {
      this.forget();
      return this.store.write([], await this.savedKeys());
    });
  }

  /** The map in parts set aside under a key of its own, never deleted: it passed validation and the loader threw */
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

/** A part's wears: each building's id and decay (0: none), as numbers in pairs. */
function wearsOf(records: readonly Building[]): Blob {
  const pairs: number[] = [];
  for (const b of records) pairs.push(b.id, b.decay ?? 0);
  return new Blob([JSON.stringify(pairs)]);
}

/** A part's wears read back, by id; null when they cannot be read (the records' own wear stands). */
function readWears(text: string): Map<number, number> | null {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs) || pairs.length % 2 !== 0 || !pairs.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < pairs.length; i += 2) out.set(pairs[i] as number, pairs[i + 1] as number);
  return out;
}

/** A stored record with the wear kept for it laid over (no `decay` when it has none, as a record never worn). */
function withWear(record: unknown, wears: ReadonlyMap<number, number>): unknown {
  if (typeof record !== 'object' || record === null) return record;
  const r = record as { id?: unknown; decay?: number };
  const decay = typeof r.id === 'number' ? wears.get(r.id) : undefined;
  if (decay === undefined || decay === (r.decay ?? 0)) return record;
  const { decay: _was, ...rest } = r;
  return decay === 0 ? rest : { ...rest, decay };
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
