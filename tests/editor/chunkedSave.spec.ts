import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS_PER_PART, type PartStore, PartedSaves } from '@editor/chunkedSave';
import { type LargeStore, Persistence, normalizeSettings } from '@editor/persistence';
import { RoadDoc } from '@world/doc';

/**
 * A LARGE MAP IS SAVED IN PARTS (`chunkedSave.ts`): never one text of the
 * whole map. What is read back is the map as it was, and a save writes again
 * only the parts whose buildings changed.
 */

/** An IndexedDB stand-in that counts what each write touched. */
function memoryStore(): PartStore & { readonly blobs: Map<string, Blob>; writes: string[][] } {
  const blobs = new Map<string, Blob>();
  const store = {
    blobs,
    writes: [] as string[][],
    async get(keys: readonly string[]) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put: readonly (readonly [string, Blob])[], remove: readonly string[]) {
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

  it('writes again only the parts whose buildings changed', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const parts = (keys: readonly string[]): string[] => keys.filter((k) => k.includes(':part:'));
    expect(parts(store.writes[0]!).length).toBeGreaterThan(1);
    // Nothing changed: the head and the manifest, no part.
    await saves.save(doc, {});
    expect(parts(store.writes[1]!)).toEqual([]);
    // One building changed: its part alone.
    const one = [...doc.buildings.all()][3]!;
    doc.buildings.put({ ...one, decay: 0.5 });
    await saves.save(doc, {});
    expect(parts(store.writes[2]!)).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`]);
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
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

  it('a map saved whole again leaves no parts behind', async () => {
    useStorage();
    const parts = memoryStore();
    await new PartedSaves(parts, KEY).save(town(), settings, 1000);
    expect(parts.blobs.size).toBeGreaterThan(2);
    new Persistence(undefined, largeStore(), parts).saveSession(small(), settings);
    await vi.waitFor(() => expect(parts.blobs.size).toBe(0));
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
