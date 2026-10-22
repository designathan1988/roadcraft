import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SAVE_TILE, TiledSaves } from '@editor/chunkedSave';
import { type PartStore, gzip, writeBatch } from '@editor/saveStore';
import { type LargeStore, Persistence, normalizeSettings, readMapFile } from '@editor/persistence';
import { mapFileBlob } from '@editor/mapExport';
import { MANIFEST_MAGIC, magicOf } from '@editor/saveBinary';
import { preparedCity } from '@editor/preparedCity';
import { GLOBAL_PARTS, RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { CELL } from '@world/cells';

/** THE SAVES ARE BINARY END TO END (`saveBinary.ts`, `chunkedSave.ts` manifest 6, `mapExport.ts`): saved, loaded and saved again to the very same bytes; the JSON saves before them open and are saved as regions; an edit rewrites its region alone; no text of the whole map is ever made. */

type MemoryStore = PartStore & { readonly blobs: Map<string, Blob>; writes: string[][] };

function memoryStore(): MemoryStore {
  const blobs = new Map<string, Blob>();
  const store: MemoryStore = {
    blobs,
    writes: [],
    async get(keys) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put, remove) {
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      store.writes.push(put.map(([k]) => k));
      return true;
    },
    writer: { write: (batch) => writeBatch(store, batch) },
  };
  return store;
}

const KEY = 'roadcraft.world.v7';
const real = (globalThis as { localStorage?: Storage | undefined }).localStorage;
afterEach(() => { (globalThis as { localStorage?: Storage | undefined }).localStorage = real; vi.restoreAllMocks(); });
function useStorage(): void {
  const items = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() { return items.size; },
    key: (n: number) => [...items.keys()][n] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
    clear: () => items.clear(),
  };
}
const largeStore = (): LargeStore & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, get: async (k) => items.get(k) ?? null, put: async (k, v) => { items.set(k, v); return true; }, delete: async (k) => items.delete(k) };
};
const settings = normalizeSettings({ camera: { x: 3, y: 4, zoom: 1 }, paused: true, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false });

/** The small city of seed 7 as the page opens it: its buildings in their table. */
function smallCity(): RoadDoc {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL('small-7.json.gz', dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL('small-7.table.gz', dir)));
  const city = preparedCity(data, tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const doc = new RoadDoc();
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: city.table!, whole: true });
  return doc;
}

const bytesOf = async (blob: Blob): Promise<Buffer> => Buffer.from(await blob.arrayBuffer());
/** Every blob of a store, by key, as bytes. */
async function contents(store: MemoryStore): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const [k, b] of store.blobs) out.set(k, await bytesOf(b));
  return out;
}
/** Waits for a Persistence's write, and the pointer it leaves. */
const saved = async (p: Persistence): Promise<void> => { await p.written(); };

describe('the autosave as binary regions', () => {
  it('saves, loads and saves again to the very same bytes through the real persistence path', async () => {
    useStorage();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first = memoryStore();
    const writer = new Persistence(undefined, largeStore(), first);
    writer.saveSession(smallCity(), settings);
    await saved(writer);
    expect(magicOf(await first.blobs.get(`${KEY}:regions`)!.arrayBuffer())).toBe(MANIFEST_MAGIC);
    // Every square's blob compressed (gzip), never JSON text.
    for (const [k, b] of await contents(first)) if (k.includes(':R:')) expect([b[0], b[1]]).toEqual([0x1f, 0x8b]);

    // Opened as the page opens it, and saved by another store: the same keys, the same bytes.
    const reader = new Persistence(undefined, largeStore(), first);
    const session = await reader.loadSessionAsync();
    const loaded = RoadDoc.fromJSON(session!.document, { repair: false });
    const second = memoryStore();
    const again = new Persistence(undefined, largeStore(), second);
    again.saveSession(loaded, session!.settings);
    await saved(again);
    const a = await contents(first), b = await contents(second);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, bytes] of a) expect(Buffer.compare(bytes, b.get(k)!), k).toBe(0);
  });

  it('rewrites only the region of a one-building edit', async () => {
    const doc = smallCity();
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    const squares = store.writes[0]!.filter((k) => k.startsWith('map:R:buildings:')).length;
    expect(squares).toBeGreaterThan(10);
    const one = [...doc.buildings.all()][40]!;
    doc.buildings.put({ ...one, name: 'Edited' });
    await saves.save(doc, {});
    const at = `${Math.floor(one.x / CELL)},${Math.floor(one.y / CELL)}`;
    expect(store.writes.at(-1)).toEqual([`map:R:buildings:${at}`, `map:RW:${at}`, 'map:regions']);
    const read = await saves.read();
    expect(read!.document.buildings!.find((b) => (b as { id: number }).id === one.id)).toMatchObject({ name: 'Edited' });
  });

  it('never makes a text of the whole map: each text one square\'s records, far below the map', async () => {
    const doc = smallCity();
    const whole = doc.toText().length;
    const realStringify = JSON.stringify.bind(JSON);
    let longest = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: never) => {
      const text = realStringify(value, replacer, space);
      if (text !== undefined) longest = Math.max(longest, text.length);
      return text;
    }) as typeof JSON.stringify);
    useStorage();
    const p = new Persistence(undefined, largeStore(), memoryStore());
    p.saveSession(doc, settings);
    await saved(p);
    expect(longest).toBeGreaterThan(0);
    // The buildings are their tables, no text at all; the longest text is one part of the map kept outside the squares, or one square.
    expect(longest).toBeLessThan(whole / 20);
  });
});

describe('the JSON saves before the binary regions', () => {
  /** A map saved by tiles in JSON (manifest 5, the format of 2026-10-19), every record in the square at the origin. */
  async function tiledJsonSave(store: MemoryStore, doc: RoadDoc, savedAt: number): Promise<void> {
    const json = doc.toJSON() as unknown as Record<string, unknown>;
    const keyed: Record<string, unknown[] | undefined> = {
      nodes: json['nodes'] as unknown[], segments: json['segments'] as unknown[], poles: json['poles'] as unknown[], spans: json['poleSpans'] as unknown[],
      landscape: json['landscape'] as unknown[], barriers: json['barriers'] as unknown[], buildings: json['buildings'] as unknown[], lots: json['lots'] as unknown[],
    };
    const lists: Record<string, unknown[] | undefined> = {
      stamps: json['terrain'] as unknown[], paint: json['paint'] as unknown[], trees: json['trees'] as unknown[], clouds: json['clouds'] as unknown[],
      elements: json['elements'] as unknown[], clearings: json['treeClearings'] as unknown[], zones: json['zones'] as unknown[], zoneMarks: json['zoneMarks'] as unknown[],
      fog: (json['fog'] as { dabs?: unknown[] } | undefined)?.dabs, gullies: (json['gullies'] as { dabs?: unknown[] } | undefined)?.dabs,
    };
    const put: [string, Blob][] = [];
    const squares: Record<string, string[]> = {};
    for (const [name, r] of Object.entries(keyed)) {
      if (!r?.length) continue;
      squares[name] = ['0,0'];
      put.push([`map:L:${name}:0,0`, await gzip(JSON.stringify(name === 'lots' ? { r, o: r.map((_, i) => i) } : { r }))]);
    }
    for (const [name, r] of Object.entries(lists)) {
      if (!r?.length) continue;
      squares[name] = ['0,0'];
      put.push([`map:L:${name}:0,0`, await gzip(JSON.stringify({ r, o: r.map((_, i) => i + 1) }))]);
    }
    for (const part of GLOBAL_PARTS) put.push([`map:G:${part}`, await gzip(JSON.stringify(doc.savedGlobals(part)))]);
    put.push(['map:tiles', new Blob([JSON.stringify({ version: 5, savedAt, settings: { camera: 5 }, squares, globals: GLOBAL_PARTS })])]);
    await store.write(put, []);
  }

  it('a map by tiles in JSON opens, and its next save writes it as binary regions, the JSON kept for an older build', async () => {
    const original = smallCity();
    const store = memoryStore();
    await tiledJsonSave(store, original, 77);
    const saves = new TiledSaves(store, 'map');
    const read = await saves.read();
    expect(read?.savedAt).toBe(77);
    expect(read?.layout.old).toContain('map:tiles');
    const doc = RoadDoc.fromJSON(read!.document, { repair: false });
    expect(doc.buildings.size).toBe(original.buildings.size);
    saves.adopt(doc, read!.layout);
    const before = new Map(store.blobs);
    await saves.save(doc, { camera: 6 }, 88);
    for (const [k, blob] of before) expect(store.blobs.get(k)).toBe(blob);
    expect(store.blobs.has('map:regions')).toBe(true);
    expect(store.writes.at(-1)!.filter((k) => k.startsWith('map:R:buildings:')).length).toBeGreaterThan(10);
    const again = await new TiledSaves(store, 'map').read();
    expect(again?.layout.old).toBeNull();
    expect(again?.savedAt).toBe(88);
    expect(JSON.stringify(RoadDoc.fromJSON(again!.document, { repair: false }).toJSON().buildings?.length)).toBe(String(original.buildings.size));
  });

  it('a whole map saved as one JSON text opens, and is saved next as binary regions', async () => {
    useStorage();
    const large = largeStore();
    const parts = memoryStore();
    const small = RoadDoc.fromJSON({ version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] } as never);
    large.items.set(KEY, JSON.stringify({ version: 2, savedAt: 500, document: small.toJSON(), settings }));
    localStorage.setItem(KEY, '{"version":2,"stored":"indexeddb","savedAt":500}');
    const p = new Persistence(undefined, large, parts);
    const session = await p.loadSessionAsync();
    expect(session?.document.nodes).toHaveLength(2);
    const doc = RoadDoc.fromJSON(session!.document);
    p.adoptLoaded(doc);
    p.saveSession(doc, settings);
    await p.written();
    expect(parts.blobs.has(`${KEY}:regions`)).toBe(true);
    expect([...parts.blobs.keys()].filter((k) => k.startsWith(`${KEY}:R:nodes:`))).toEqual([`${KEY}:R:nodes:${Math.floor(0 / SAVE_TILE)},0`]);
    const next = await new Persistence(undefined, large, parts).loadSessionAsync();
    expect(next?.document.nodes).toHaveLength(2);
  });
});

describe('the map file', () => {
  it('is binary (magic and version), and opens as the map it was', async () => {
    const doc = smallCity();
    const blob = mapFileBlob(doc, settings);
    const bytes = await blob.arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4))).toBe('RCMF');
    expect(new DataView(bytes).getUint32(4, true)).toBe(1);
    const session = readMapFile(bytes);
    expect(session?.settings.camera).toEqual(settings.camera);
    expect(JSON.stringify(RoadDoc.fromJSON(session!.document, { repair: false }).toJSON())).toBe(JSON.stringify(doc.toJSON()));
    expect(bytes.byteLength).toBeLessThan(doc.toText().length);
  });

  it('opens the JSON files of the builds before it, a session and a map alone, and refuses what is neither', () => {
    const doc = RoadDoc.fromJSON({ version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] } as never);
    const encode = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer;
    expect(readMapFile(encode({ version: 2, document: doc.toJSON(), settings }))?.settings.camera).toEqual(settings.camera);
    expect(readMapFile(encode(doc.toJSON()))?.document.nodes).toHaveLength(2);
    expect(readMapFile(encode({ hello: 1 }))).toBeNull();
    expect(readMapFile(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
  });
});
