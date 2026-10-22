import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_TILE, TiledSaves } from '@editor/chunkedSave';
import { type PartStore, type SaveBatch, gzip, writeBatch } from '@editor/saveStore';
import { type LargeStore, Persistence, normalizeSettings } from '@editor/persistence';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { CELL } from '@world/cells';

/** THE MAP IS SAVED BY TILES (`chunkedSave.ts`): an edit writes the squares it reached, never one text of the whole map. */

type MemoryStore = PartStore & { readonly blobs: Map<string, Blob>; writes: string[][]; batches: SaveBatch[]; refuse: boolean };

/** An IndexedDB stand-in that counts what each write touched and keeps each batch the writer was handed; `refuse` fails the next write. */
function memoryStore(): MemoryStore {
  const blobs = new Map<string, Blob>();
  const batches: SaveBatch[] = [];
  const store: MemoryStore = {
    blobs,
    writes: [],
    batches,
    refuse: false,
    async get(keys) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put, remove) {
      if (store.refuse) { store.refuse = false; return false; }
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      store.writes.push(put.map(([k]) => k));
      return true;
    },
    writer: { write: (batch) => { batches.push(batch); return writeBatch(store, batch); } },
  };
  return store;
}

/** The records a batch handed to the writer: what the page copied and the worker made text. */
const recordsIn = (batch: SaveBatch): number => batch.put.reduce((n, entry) => {
  const value = entry.value as { r?: unknown };
  return n + (Array.isArray(value?.r) ? value.r.length : 0);
}, 0);

const town = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));

/** A map in the file's form with its keyed lists by id: the order of a map's records by id means nothing (a list's order does). */
function canonical(json: SerializedDoc): unknown {
  const byId = (list: readonly unknown[] | undefined): unknown[] => [...(list ?? [])].sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
  return {
    ...json, nodes: byId(json.nodes), segments: byId(json.segments), poles: byId(json.poles), poleSpans: byId(json.poleSpans),
    landscape: byId(json.landscape), barriers: byId(json.barriers), buildings: byId(json.buildings), lots: byId(json.lots),
  };
}
const same = (read: { document: SerializedDoc } | null, doc: RoadDoc): void => {
  expect(canonical(RoadDoc.fromJSON(read!.document).toJSON())).toEqual(canonical(doc.toJSON()));
};

const square = (x: number, y: number, side: number): string => `${Math.floor(x / side)},${Math.floor(y / side)}`;

describe('a map saved by tiles', () => {
  it('reads back the map it saved', async () => {
    const doc = town();
    const saves = new TiledSaves(memoryStore(), 'map');
    expect(await saves.save(doc, { camera: 1 }, 1234)).toBe(true);
    const read = await saves.read();
    expect(read?.savedAt).toBe(1234);
    expect(read?.settings).toEqual({ camera: 1 });
    same(read, doc);
  });

  it('writes again only the squares the diary says changed', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    expect(store.writes[0]!.filter((k) => k.includes(':L:buildings:')).length).toBeGreaterThan(1);
    expect(store.writes[0]).toContain('map:G:values');
    // Nothing changed: the manifest alone.
    await saves.save(doc, {});
    expect(store.writes[1]).toEqual(['map:tiles']);
    // One building changed: its square alone (records and wears), nothing else.
    const one = [...doc.buildings.all()][3]!;
    doc.buildings.put({ ...one, decay: 0.5 });
    await saves.save(doc, {});
    const at = square(one.x, one.y, CELL);
    expect(store.writes[2]).toEqual([`map:L:buildings:${at}`, `map:W:${at}`, 'map:tiles']);
    // A road changed: road squares alone, no building and nothing kept outside the tiles.
    const node = [...doc.nodes.values()][0]!;
    doc.setNodeHeightOffset(node.id, node.heightOffset + 1);
    await saves.save(doc, {});
    const written = store.writes[3]!.filter((k) => k !== 'map:tiles');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((k) => k.startsWith('map:L:nodes:') || k.startsWith('map:L:segments:'))).toBe(true);
    expect(written).toContain(`map:L:nodes:${square(node.x, node.y, SAVE_TILE)}`);
    same(await saves.read(), doc);
  });

  it('writes a building aged as the wears of its square, never the records of its square again', async () => {
    // DO NOT write a square's records for wear
    const doc = town();
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    const aged = [...doc.buildings.all()].filter((_, i) => i % 97 === 0);
    for (const b of aged) doc.buildings.wear(b.id, 0.6);
    await saves.save(doc, {});
    const written = store.writes.at(-1)!;
    expect(written.filter((k) => k.includes(':L:'))).toEqual([]);
    expect(written.filter((k) => k.includes(':W:')).length).toBe(new Set(aged.map((b) => square(b.x, b.y, CELL))).size);
    same(await saves.read(), doc);
    // Without the wears (a square written before them), the records read as they are.
    for (const key of [...store.blobs.keys()]) if (key.includes(':W:')) store.blobs.delete(key);
    expect((await saves.read())!.document.buildings!.length).toBe(doc.buildings.size);
  });

  it('keeps what a failed write did not write for the next save', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    const one = [...doc.buildings.all()][5]!;
    doc.buildings.put({ ...one, decay: 0.25 });
    store.refuse = true;
    expect(await saves.save(doc, {})).toBe(false);
    await saves.save(doc, {});
    const at = square(one.x, one.y, CELL);
    expect(store.writes.at(-1)).toEqual([`map:L:buildings:${at}`, `map:W:${at}`, 'map:tiles']);
    same(await saves.read(), doc);
  });

  it('a map opened from its tiles is not written again whole', async () => {
    const store = memoryStore();
    await new TiledSaves(store, 'map').save(town(), {});
    const reader = new TiledSaves(store, 'map');
    const read = await reader.read();
    const doc = RoadDoc.fromJSON(read!.document);
    reader.adopt(doc, read!.layout);
    const one = [...doc.buildings.all()][2]!;
    doc.buildings.put({ ...one, decay: 0.75 });
    await reader.save(doc, {});
    const at = square(one.x, one.y, CELL);
    expect(store.writes.at(-1)).toEqual([`map:L:buildings:${at}`, `map:W:${at}`, 'map:tiles']);
    same(await reader.read(), doc);
  });

  it('a square left without buildings goes', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    const one = [...doc.buildings.all()][0]!;
    const at = square(one.x, one.y, CELL);
    for (const b of [...doc.buildings.all()]) if (square(b.x, b.y, CELL) === at) doc.buildings.remove(b.id);
    await saves.save(doc, {});
    expect(store.blobs.has(`map:L:buildings:${at}`)).toBe(false);
    expect(store.blobs.has(`map:W:${at}`)).toBe(false);
    same(await saves.read(), doc);
  });

  it('reads nothing where nothing was saved', async () => {
    expect(await new TiledSaves(memoryStore(), 'map').read()).toBeNull();
  });
});

describe('an edit in one tile writes that tile, whatever the size of the map', () => {
  /** Ten poles and ten trees in the tile at the origin, and as many in each of `others` tiles south of it. */
  function field(others: number): RoadDoc {
    const doc = RoadDoc.fromJSON({ version: 1, nodes: [], segments: [] } as never);
    const plant = (x: number, y: number): void => { doc.plantTrees([{ x, y, height: 8, yaw: 0, seed: 0.5 }]); };
    for (let i = 0; i < 10; i++) { doc.addPole({ x: 100 + i * 50, y: 100 }); plant(120 + i * 50, 200); }
    for (let t = 0; t < others; t++) {
      // South of the origin's tile (y < 0): never in it.
      const x0 = -4_500 + (t % 9) * 1_024, y0 = -4_500 + Math.floor(t / 9) * 400;
      for (let i = 0; i < 10; i++) { doc.addPole({ x: x0 + i * 50, y: y0 }); plant(x0 + i * 50, y0 + 100); }
    }
    return doc;
  }

  /** The records the save after one pole and one tree added at the origin's tile handed on, and the keys it wrote. */
  async function oneEdit(doc: RoadDoc): Promise<{ records: number; keys: readonly string[] }> {
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    doc.addPole({ x: 300, y: 300 });
    doc.plantTrees([{ x: 400, y: 400, height: 9, yaw: 1, seed: 0.25 }]);
    await saves.save(doc, {});
    same(await saves.read(), doc);
    return { records: recordsIn(store.batches.at(-1)!), keys: store.writes.at(-1)! };
  }

  it('hands on the same records for a map of one tile and a map of eighty-two', async () => {
    const small = await oneEdit(field(0));
    const big = await oneEdit(field(81));
    // The tile's eleven poles and eleven trees, and nothing of the other tiles.
    expect(small.records).toBe(22);
    expect(big.records).toBe(small.records);
    const origin = square(0, 0, SAVE_TILE);
    expect(big.keys).toEqual([`map:L:poles:${origin}`, `map:L:trees:${origin}`, 'map:tiles']);
  });

  it('keeps the order of a list spread over tiles through cuts and plantings', async () => {
    // The order is meaning (the oldest trees go first at the cap; stamps and dabs are laid in turn).
    const doc = RoadDoc.fromJSON({ version: 1, nodes: [], segments: [] } as never);
    const trees = Array.from({ length: 40 }, (_, i) => ({ x: (i % 2 ? 2_000 : 100) + i * 10, y: 100, height: 8, yaw: 0, seed: i / 40 }));
    doc.plantTrees(trees);
    const store = memoryStore();
    const saves = new TiledSaves(store, 'map');
    await saves.save(doc, {});
    doc.cutTrees(100 + 4 * 10, 100, 5);
    doc.plantTrees([{ x: 150, y: 120, height: 7, yaw: 0, seed: 0.9 }, { x: 2_100, y: 120, height: 7, yaw: 0, seed: 0.1 }]);
    await saves.save(doc, {});
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON().trees).toEqual(doc.toJSON().trees);
    // Opened and cut again: still the same order.
    const reader = new TiledSaves(store, 'map');
    const opened = RoadDoc.fromJSON(read!.document);
    reader.adopt(opened, read!.layout);
    opened.cutTrees(2_000 + 7 * 10, 100, 5);
    await reader.save(opened, {});
    expect(store.writes.at(-1)!.filter((k) => k.includes(':L:trees:'))).toEqual([`map:L:trees:${square(2_070, 100, SAVE_TILE)}`]);
    expect(RoadDoc.fromJSON((await reader.read())!.document).toJSON().trees).toEqual(opened.toJSON().trees);
  });
});

describe('a map saved before the tiles', () => {
  /** The format of 2026-10 (manifest 3): the head in one text, the buildings in parts of 512 ids, no wears. */
  async function oldSave(store: MemoryStore, doc: RoadDoc, savedAt: number): Promise<void> {
    const { buildings = [], ...head } = doc.toJSON();
    const parts = new Map<number, unknown[]>();
    for (const b of buildings) {
      const part = Math.floor((b as { id: number }).id / 512);
      const list = parts.get(part);
      if (list) list.push(b); else parts.set(part, [b]);
    }
    const put: [string, Blob][] = [['map:head', await gzip(JSON.stringify(head))]];
    for (const [part, list] of parts) put.push([`map:part:${part}`, await gzip(JSON.stringify(list))]);
    put.push(['map:manifest', new Blob([JSON.stringify({ version: 3, savedAt, parts: [...parts.keys()], settings: { camera: 2 } })])]);
    await store.write(put, []);
  }

  it('opens, and its next save writes it by tiles and keeps the old save for an older build', async () => {
    const store = memoryStore();
    const original = town();
    await oldSave(store, original, 55);
    const saves = new TiledSaves(store, 'map');
    const read = await saves.read();
    expect(read?.savedAt).toBe(55);
    expect(read?.settings).toEqual({ camera: 2 });
    expect(read?.layout.old).toContain('map:head');
    same(read, original);
    // The player's map opened, then saved: by tiles; the old save left as it was (the player's, an older build's only copy).
    const doc = RoadDoc.fromJSON(read!.document);
    saves.adopt(doc, read!.layout);
    const before = new Map(store.blobs);
    await saves.save(doc, { camera: 3 }, 66);
    for (const k of ['map:head', 'map:manifest', ...[...before.keys()].filter((k) => k.startsWith('map:part:'))]) expect(store.blobs.get(k)).toBe(before.get(k));
    expect([...store.blobs.keys()].some((k) => k.startsWith('map:L:buildings:'))).toBe(true);
    const again = await new TiledSaves(store, 'map').read();
    expect(again?.layout.old).toBeNull();
    expect(again?.savedAt).toBe(66);
    same(again, original);
  });
});

describe('a map by tiles among the other copies', () => {
  const KEY = 'roadcraft.world.v7';
  const real = (globalThis as { localStorage?: Storage | undefined }).localStorage;
  afterEach(() => { (globalThis as { localStorage?: Storage | undefined }).localStorage = real; });
  const useStorage = (): void => {
    const items = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() { return items.size; },
      key: (n: number) => [...items.keys()][n] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => { items.set(k, String(v)); },
      removeItem: (k: string) => { items.delete(k); },
      clear: () => items.clear(),
    };
  };
  const largeStore = (): LargeStore & { items: Map<string, string> } => {
    const items = new Map<string, string>();
    return { items, get: async (k) => items.get(k) ?? null, put: async (k, v) => { items.set(k, v); return true; }, delete: async (k) => items.delete(k) };
  };
  const settings = normalizeSettings({ camera: { x: 0, y: 0, zoom: 1 }, paused: true, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false });
  const small = (): RoadDoc => RoadDoc.fromJSON({ version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] } as never);

  it('the newest copy opens, whichever store holds it', async () => {
    useStorage();
    const parts = memoryStore();
    const large = largeStore();
    const whole = (savedAt: number): string => JSON.stringify({ version: 2, savedAt, document: small().toJSON(), settings });
    await new TiledSaves(parts, KEY).save(town(), settings, 1000);
    large.items.set(KEY, whole(2000));
    // The whole copy is newer: a large map gave way to a smaller one saved after it.
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings ?? []).toHaveLength(0);
    await new TiledSaves(parts, KEY).save(town(), settings, 3000);
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings?.length).toBe(town().buildings.size);
  });

  it('a small map is saved by tiles too, never as one text', async () => {
    // Chosen by the count of buildings, a map of few buildings was written whole on every edit, whatever its roads
    useStorage();
    const parts = memoryStore();
    const large = largeStore();
    new Persistence(undefined, large, parts).saveSession(small(), settings);
    await vi.waitFor(() => expect(parts.blobs.has(`${KEY}:tiles`)).toBe(true));
    expect(large.items.size).toBe(0);
    expect(localStorage.getItem(KEY)).toContain('"stored":"parts"');
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.nodes?.length).toBe(2);
  });

  it('a map by tiles that failed to load is set aside, never deleted', async () => {
    useStorage();
    const parts = memoryStore();
    await new TiledSaves(parts, KEY).save(town(), settings, 1000);
    const held = parts.blobs.size;
    new Persistence(undefined, largeStore(), parts).quarantineStored();
    await vi.waitFor(() => expect([...parts.blobs.keys()].every((k) => k.startsWith(`${KEY}.unreadable.`))).toBe(true));
    expect(parts.blobs.size).toBe(held);
    // Not read again on the next opening.
    expect(await new Persistence(undefined, largeStore(), parts).loadSessionAsync()).toBeNull();
  });
});
