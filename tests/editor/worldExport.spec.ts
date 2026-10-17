import { describe, expect, it } from 'vitest';
import type { PartStore } from '@editor/saveStore';
import { TileStore, type WorldMeta, storeTiles } from '@editor/tileStore';
import { readWorldFile, saveWorldFile, worldFilePieces } from '@editor/worldExport';
import type { TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';

/** A STREAMED WORLD SAVED TO ONE FILE AND OPENED AGAIN (`worldExport.ts`): every stored tile and the world's values, the same after the round trip */

function memoryStore(): PartStore {
  const blobs = new Map<string, Blob>();
  return {
    async get(keys) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put, remove) { for (const [k, b] of put) blobs.set(k, b); for (const k of remove) blobs.delete(k); return true; },
  };
}

const never = (): Promise<TileRecords> => Promise.reject(new Error('not stored'));

function tile(i: number, j: number): TileRecords {
  const key = tileKey(i, j), base = tileIdBase(key);
  return {
    key, version: 0, nodes: [{ id: base, x: i * m(1024) + m(10), y: j * m(1024) + m(10) }], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [],
    buildings: [], lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [{ x: i * m(1024) + m(5), y: j * m(1024) + m(5) } as never], elements: [],
    next: { node: base + 1, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

describe('a city saved to a file', () => {
  it('holds every stored tile and its values, and opened puts the same tiles in a store', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    const tiles = [tile(0, 0), tile(1, 0), tile(-1, 2)];
    for (const t of tiles) await from.write(t);
    const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: { economy: { balance: 9 } } };
    await from.setMeta(meta);
    const keys = [...tiles.map((t) => t.key), tileKey(3, 3)];
    const pieces = await worldFilePieces((await from.meta())!, keys, (key) => from.readText(key));
    const file = readWorldFile(JSON.parse(await new Blob(pieces).text()));
    expect(file).not.toBeNull();
    expect(file!.meta).toEqual(meta);
    expect(file!.tiles.map((t) => t.key)).toEqual(tiles.map((t) => t.key));
    const into = new TileStore('map', storeTiles(memoryStore()), never);
    await into.setMeta(file!.meta);
    for (const t of file!.tiles) await into.write(t);
    for (const t of tiles) {
      const back = (await into.read(t.key))!;
      expect(back.nodes).toEqual(t.nodes);
      expect(back.trees).toEqual(t.trees);
    }
    expect((await into.meta())?.values).toEqual(meta.values);
  });

  it('is not taken for a map file of another kind', () => {
    expect(readWorldFile({ version: 2, document: {} })).toBeNull();
    expect(readWorldFile({ version: 3, world: { version: 1, unit: 1, generator: null }, tiles: [] })).toBeNull();
  });

  it('refuses a file whose tile lacks a list or a counter, or lies off the map', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    await from.write(tile(0, 0));
    const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} };
    await from.setMeta(meta);
    const text = await new Blob(await worldFilePieces((await from.meta())!, [tileKey(0, 0)], (key) => from.readText(key))).text();
    const good = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    expect(readWorldFile(good)).not.toBeNull();
    // A tile without its trees' list.
    const holed = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    for (const part of holed.tiles[0]!) delete part['trees'];
    expect(readWorldFile(holed)).toBeNull();
    // A tile far past the map's edge.
    const off = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    for (const part of off.tiles[0]!) if ('key' in part) part['key'] = tileKey(5000, 0);
    expect(readWorldFile(off)).toBeNull();
  });

  it('makes no file while a change is not written, nor from a tab that only reads the world', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    await from.write(tile(0, 0));
    await from.setMeta({ version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} });
    const offered: Blob[] = [];
    const offer = (blob: Blob): boolean => { offered.push(blob); return true; };
    const keys = [tileKey(0, 0)];
    expect(await saveWorldFile({ streamer: { flush: async () => false, readOnly: false }, store: from }, keys, offer)).toBe('hint.saveBehind');
    expect(await saveWorldFile({ streamer: { flush: async () => true, readOnly: true }, store: from }, keys, offer)).toBe('hint.worldReadOnly');
    expect(offered).toHaveLength(0);
    expect(await saveWorldFile({ streamer: { flush: async () => true, readOnly: false }, store: from }, keys, offer)).toBe('hint.saved');
    expect(offered).toHaveLength(1);
  });

  it('opened into a store: each tile above the version stored, the tiles of the map it lacks taken away, the values last', async () => {
    const blobs = memoryStore();
    const store = new TileStore('map', storeTiles(blobs), never);
    // The store holds an older world: (0,0) at a high version, (2,2) the file does not have.
    for (let k = 0; k < 4; k++) await store.write(tile(0, 0));
    await store.write(tile(2, 2));
    const before = (await store.read(tileKey(0, 0)))!.version;
    const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} };
    const fresh = new TileStore('map', storeTiles(blobs), never);
    expect(await fresh.importWorld(meta, [{ ...tile(0, 0), version: 1 }], [tileKey(0, 0), tileKey(2, 2), tileKey(3, 3)])).toBe(true);
    expect((await fresh.read(tileKey(0, 0)))!.version).toBeGreaterThan(before);
    expect(await fresh.read(tileKey(2, 2))).toBeNull();
    expect((await fresh.meta())?.generator).toEqual(meta.generator);
  });

  it('refuses a file of another plan of the map: its tiles would be another city', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    await from.write(tile(0, 0));
    await from.setMeta({ version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} });
    const file = JSON.parse(await new Blob(await worldFilePieces((await from.meta())!, [tileKey(0, 0)], (key) => from.readText(key))).text()) as { plan: { plan: number } };
    expect(readWorldFile(file)).not.toBeNull();
    file.plan.plan -= 1;
    expect(readWorldFile(file)).toBeNull();
    delete (file as { plan?: unknown }).plan;
    expect(readWorldFile(file)).toBeNull();
  });
});
