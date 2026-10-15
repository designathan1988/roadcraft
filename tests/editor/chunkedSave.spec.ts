import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS_PER_PART, type PartStore, PartedSaves } from '@editor/chunkedSave';
import { type LargeStore, Persistence, normalizeSettings } from '@editor/persistence';
import { RoadDoc } from '@world/doc';

/**
 * THE MAP IS SAVED IN PARTS (`chunkedSave.ts`): never one text of the whole
 * map. What is read back is the map as it was, and a save writes again only
 * what the diary says changed: the parts of the buildings it names, the head
 * only when something of the head changed.
 */

/** An IndexedDB stand-in that counts what each write touched; `refuse` makes the next write fail. */
function memoryStore(): PartStore & { readonly blobs: Map<string, Blob>; writes: string[][]; refuse: boolean } {
  const blobs = new Map<string, Blob>();
  const store = {
    blobs,
    writes: [] as string[][],
    refuse: false,
    async get(keys: readonly string[]) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put: readonly (readonly [string, Blob])[], remove: readonly string[]) {
      if (store.refuse) { store.refuse = false; return false; }
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      store.writes.push(put.map(([k]) => k));
      return true;
    },
  };
  return store;
}

const town = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('maps/cidade-com-estacionamento.json', 'utf8')));

describe('a map saved in parts', () => {
  it('reads back the map it saved', async () => {
    const doc = town();
    expect(doc.buildings.size).toBeGreaterThan(BUILDINGS_PER_PART);
    const saves = new PartedSaves(memoryStore(), 'map');
    expect(await saves.save(doc, { camera: 1 }, 1234)).toBe(true);
    const read = await saves.read();
    expect(read?.savedAt).toBe(1234);
    expect(read?.settings).toEqual({ camera: 1 });
    // The same document as the whole-text save gives.
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes again only what the diary says changed', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const parts = (keys: readonly string[]): string[] => keys.filter((k) => k.includes(':part:'));
    expect(parts(store.writes[0]!).length).toBeGreaterThan(1);
    expect(store.writes[0]).toContain('map:head');
    // Nothing changed: the manifest alone, no part and no head.
    await saves.save(doc, {});
    expect(store.writes[1]).toEqual(['map:manifest']);
    // One building changed: its part alone, not the head.
    const one = [...doc.buildings.all()][3]!;
    doc.buildings.put({ ...one, decay: 0.5 });
    await saves.save(doc, {});
    expect(store.writes[2]).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    // A road changed: the head alone, no part.
    const node = [...doc.nodes.values()][0]!;
    doc.setNodeHeightOffset(node.id, node.heightOffset + 1);
    await saves.save(doc, {});
    expect(store.writes[3]).toEqual(['map:head', 'map:manifest']);
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes a building aged as the wears of its part, never the records of its part again', async () => {
    // DO NOT write a part's records for wear: the town ageing turned every part of the map into text and
    // gzipped it again, 512 records for one number each (2026-10-15).
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const aged = [...doc.buildings.all()].filter((_, i) => i % 97 === 0);
    for (const b of aged) doc.buildings.wear(b.id, 0.6);
    await saves.save(doc, {});
    const written = store.writes.at(-1)!;
    expect(written.filter((k) => k.includes(':part:'))).toEqual([]);
    expect(written.filter((k) => k.includes(':wear:')).length).toBe(new Set(aged.map((b) => Math.floor(b.id / BUILDINGS_PER_PART))).size);
    // Read back, worn: the wears laid over the records stored before.
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
    // A map saved before the wears were kept apart (no `:wear:` key) reads its records as they are.
    for (const key of [...store.blobs.keys()]) if (key.includes(':wear:')) store.blobs.delete(key);
    const old = await saves.read();
    expect(old!.document.buildings!.length).toBe(doc.buildings.size);
  });

  it('keeps what a failed write did not write for the next save', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const one = [...doc.buildings.all()][5]!;
    doc.buildings.put({ ...one, decay: 0.25 });
    store.refuse = true;
    expect(await saves.save(doc, {})).toBe(false);
    await saves.save(doc, {});
    expect(store.writes.at(-1)).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('a map opened from its parts is not written again whole', async () => {
    const store = memoryStore();
    await new PartedSaves(store, 'map').save(town(), {});
    const reader = new PartedSaves(store, 'map');
    const read = await reader.read();
    const doc = RoadDoc.fromJSON(read!.document);
    reader.adopt(doc, read!.parts);
    const one = [...doc.buildings.all()][2]!;
    doc.buildings.put({ ...one, decay: 0.75 });
    await reader.save(doc, {});
    expect(store.writes.at(-1)).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    expect(RoadDoc.fromJSON((await reader.read())!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('a building taken away empties its part, and the part goes', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const last = Math.max(...[...doc.buildings.all()].map((b) => b.id));
    const part = Math.floor(last / BUILDINGS_PER_PART);
    for (const b of [...doc.buildings.all()]) if (Math.floor(b.id / BUILDINGS_PER_PART) === part) doc.buildings.remove(b.id);
    await saves.save(doc, {});
    expect(store.blobs.has(`map:part:${part}`)).toBe(false);
    expect(RoadDoc.fromJSON((await saves.read())!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('reads nothing where nothing was saved', async () => {
    expect(await new PartedSaves(memoryStore(), 'map').read()).toBeNull();
  });
});

describe('a map in parts among the other copies', () => {
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
    await new PartedSaves(parts, KEY).save(town(), settings, 1000);
    large.items.set(KEY, whole(2000));
    // The whole copy is newer: a large map gave way to a smaller one saved after it.
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings ?? []).toHaveLength(0);
    await new PartedSaves(parts, KEY).save(town(), settings, 3000);
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings?.length).toBe(town().buildings.size);
  });

  it('a small map is saved in parts too, never as one text', async () => {
    // Chosen by the count of buildings, a map of few buildings was written
    // whole on every edit, whatever its roads, lots and trees.
    useStorage();
    const parts = memoryStore();
    const large = largeStore();
    new Persistence(undefined, large, parts).saveSession(small(), settings);
    await vi.waitFor(() => expect(parts.blobs.has(`${KEY}:manifest`)).toBe(true));
    expect(large.items.size).toBe(0);
    expect(localStorage.getItem(KEY)).toContain('"stored":"parts"');
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.nodes?.length).toBe(2);
  });

  it('a map in parts that failed to load is set aside, never deleted', async () => {
    useStorage();
    const parts = memoryStore();
    await new PartedSaves(parts, KEY).save(town(), settings, 1000);
    const held = parts.blobs.size;
    new Persistence(undefined, largeStore(), parts).quarantineStored();
    await vi.waitFor(() => expect([...parts.blobs.keys()].every((k) => k.startsWith(`${KEY}.unreadable.`))).toBe(true));
    expect(parts.blobs.size).toBe(held);
    // Not read again on the next opening.
    expect(await new Persistence(undefined, largeStore(), parts).loadSessionAsync()).toBeNull();
  });
});
