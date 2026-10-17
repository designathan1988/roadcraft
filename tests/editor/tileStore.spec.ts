import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TiledSaves } from '@editor/chunkedSave';
import type { PartStore } from '@editor/saveStore';
import { readHead } from '@editor/tileBlob';
import {
  type MadeTile, type TileText, TileStore, type WorldMeta, readTile, readTilePart, storeTiles, storedVersion, tileOpTransfer, writeTile, prepareTile,
  preparedRecords, tileWrite, writtenRecords } from '@editor/tileStore';

/** A maker as `cityTile.worker.ts` serves one: asked only if missing, it looks in the store first (`storedVersion`), the tile read and prepared where it is there; `make` runs only for a tile the store has not. */
function lookingFirst(store: PartStore, make: (i: number, j: number, after: number, text: boolean) => Promise<MadeTile>) {
  return async (i: number, j: number, after: number, text: boolean, ifMissing: boolean): Promise<MadeTile> => {
    if (ifMissing) {
      const version = await storedVersion(store, 'map', tileKey(i, j));
      if (version === 'legacy') return { version: null, legacy: true };
      if (version !== null) {
        const records = text ? await readTile(store, 'map', tileKey(i, j)) : null;
        return { version, existed: true, ...(records ? { prepared: prepareTile(records) } : {}) };
      }
    }
    return make(i, j, after, text);
  };
}
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { TILE_COUNTED, tileIdBase, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';

/** THE TILE STORE (`tileStore.ts`): the world saved tile by tile, a missing tile generated once, a map saved before the tiles distributed into them. */

type MemoryStore = PartStore & { readonly blobs: Map<string, Blob>; writes: string[][] };

/** An IndexedDB stand-in that keeps the keys each write put. */
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
  };
  return store;
}

/** A tile with nothing in it but what `extra` lays. */
function emptyTile(i: number, j: number, extra: Partial<TileRecords> = {}): TileRecords {
  const key = tileKey(i, j), base = tileIdBase(key);
  return {
    key, version: 0, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
    ...extra,
  };
}

const node = (id: number, x: number, y: number): SerializedDoc['nodes'][number] => ({ id, x, y, heightOffset: 0, smooth: false, control: 'auto', blockedMovements: [] });
const never = (): Promise<TileRecords> => Promise.reject(new Error('no tile should be generated'));

describe('a tile stored', () => {
  it('reads back the tile it wrote, in parts under its own key', async () => {
    const store = memoryStore();
    const tiles = new TileStore('map', storeTiles(store), never);
    const tile = emptyTile(2, -3, { nodes: [node(7, m(2_100), m(-3_000))], lotKeys: ['b:1,2,3,4'] });
    expect(await tiles.write(tile)).toBe(1);
    const blob = store.blobs.get(`map:T:${tile.key}`)!;
    // Format 2's magic, "RCT2" (`tileBlob.ts`).
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 4))).toBe('RCT2');
    const read = (await readHead(blob))!;
    expect(read.head.version).toBe(1);
    expect(read.head.parts.map((p) => p[0])).toEqual(['rest', 'roads', 'buildings']);
    expect(await new TileStore('map', storeTiles(store), never).read(tile.key)).toEqual({ ...tile, version: 1 });
    expect(await tiles.read(tileKey(0, 0))).toBeNull();
  });

  it('a part read alone: the roads with no building, the buildings with no road', async () => {
    const store = memoryStore();
    const building = { id: tileIdBase(tileKey(0, 0)), x: m(10), y: m(10) };
    const tile = emptyTile(0, 0, { nodes: [node(1, m(5), m(5))], buildings: [building as never] });
    await new TileStore('map', storeTiles(store), never).write(tile);
    // With the roads, the gates of its buildings (`TileRecords.gates`): this one has none.
    expect(await readTilePart(store, 'map', tile.key, 'roads')).toEqual({ value: { nodes: tile.nodes, borrowedNodes: [], segments: [], gates: [] } });
    expect(await readTilePart(store, 'map', tile.key, 'buildings')).toEqual({ value: { buildings: [building], lots: [] } });
    // A section it was not written with: the records, for its reader to derive it from.
    expect(await readTilePart(store, 'map', tile.key, 'links')).toEqual({ records: { ...tile, version: 1, gates: [] } });
    expect(await readTilePart(store, 'map', tileKey(5, 5), 'roads')).toBeNull();
  });

  it('a tile\'s sections baked where it is written, each read alone', async () => {
    const store = memoryStore();
    const bake = vi.fn((records: TileRecords) => ({ count: { json: { n: records.nodes.length } }, bytes: { bin: Uint8Array.from([records.version, 9]) } }));
    const tile = emptyTile(1, 0, { nodes: [node(1, m(1_100), m(5)), node(2, m(1_200), m(5))] });
    await new TileStore('map', storeTiles(store, bake), never).write(tile);
    expect(bake).toHaveBeenCalledTimes(1);
    expect(await readTilePart(store, 'map', tile.key, 'count')).toEqual({ value: { n: 2 } });
    const bytes = await readTilePart(store, 'map', tile.key, 'bytes');
    expect([...new Uint8Array((bytes as { bytes: ArrayBuffer }).bytes)]).toEqual([1, 9]);
    // The records read whole as they were, the sections apart.
    expect(await readTile(store, 'map', tile.key)).toEqual({ ...tile, version: 1 });
    // Known by its head alone: no section baked again.
    expect(await storeTiles(store, bake).run({ op: 'version', map: 'map', key: tile.key })).toBe(1);
    expect(bake).toHaveBeenCalledTimes(1);
  });

  it('a tile of format 1 (one gzip of its records) is read, and written again in parts once when its version is asked', async () => {
    const store = memoryStore();
    const tile = { ...emptyTile(-1, 2, { nodes: [node(3, m(-500), m(2_500))] }), version: 3 };
    const old = await new Response(new Blob([JSON.stringify(tile)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    store.blobs.set(`map:T:${tile.key}`, old);
    expect(await new TileStore('map', storeTiles(store), never).read(tile.key)).toEqual(tile);
    expect(await readTilePart(store, 'map', tile.key, 'roads')).toEqual({ records: tile });
    // No baker: read as it is, never written.
    expect(await storeTiles(store).run({ op: 'version', map: 'map', key: tile.key })).toBe(3);
    expect(store.writes).toHaveLength(0);
    const bake = vi.fn(() => ({ mark: { json: 1 } }));
    expect(await storeTiles(store, bake).run({ op: 'version', map: 'map', key: tile.key })).toBe(3);
    expect(store.writes).toEqual([[`map:T:${tile.key}`]]);
    // In parts now, at its own version, its section with it; asked again, nothing written.
    expect((await readHead(store.blobs.get(`map:T:${tile.key}`)!))?.head.version).toBe(3);
    expect(await readTilePart(store, 'map', tile.key, 'mark')).toEqual({ value: 1 });
    expect(await readTile(store, 'map', tile.key)).toEqual(tile);
    await storeTiles(store, bake).run({ op: 'version', map: 'map', key: tile.key });
    expect(store.writes).toHaveLength(1);
  });

  it('a tile\'s texts handed over by their buffers, parsed once into the tile', async () => {
    const store = memoryStore();
    const tile = emptyTile(3, 3, { trees: [{ x: m(3_100), y: m(3_100) }] });
    await new TileStore('map', storeTiles(store), never).write(tile);
    const op = { op: 'readText', map: 'map', key: tile.key } as const;
    const text = (await storeTiles(store).run(op)) as TileText;
    expect(text).toHaveLength(3);
    expect(tileOpTransfer(op, text)).toEqual(text.map((t) => t.buffer));
    // Each text an object of some of the tile's fields: merged, the tile.
    const merged: Record<string, unknown> = {};
    for (const part of text) Object.assign(merged, JSON.parse(new TextDecoder().decode(part)) as object);
    expect(merged).toEqual({ ...tile, version: 1 });
    expect(tileOpTransfer({ op: 'read', map: 'map', key: tile.key }, text)).toEqual([]);
  });

  it('knows a tile made ahead by its version alone: one stored is read for it, one missing is made and stored by the worker', async () => {
    const store = memoryStore();
    const kept = emptyTile(1, 1);
    await new TileStore('map', storeTiles(store), never).write(kept);
    const asked: [number, number, number][] = [];
    const makeStored = lookingFirst(store, async (i, j, after) => {
      asked.push([i, j, after]);
      // As `cityTile.worker.ts` does: the tile written straight into the store, its version past `after`.
      await storeTiles(store).run({ op: 'write', map: 'map', records: tileWrite({ ...emptyTile(i, j), version: after + 1 }) });
      return { version: after + 1 };
    });
    const tiles = new TileStore('map', storeTiles(store), never, makeStored);
    expect(await tiles.ensure(kept.key)).toBe(1);
    expect(asked).toEqual([]);
    expect(await tiles.ensure(tileKey(4, -2))).toBe(1);
    expect(asked).toEqual([[4, -2, 0]]);
    // Asked again: read from the store, not made again; and a later write goes past it.
    expect(await tiles.ensure(tileKey(4, -2))).toBe(1);
    expect(asked).toHaveLength(1);
    expect(await tiles.write(emptyTile(4, -2))).toBe(2);
  });

  it('a region tile not stored is made and stored by the generator\'s worker, the page handed its texts and never writing it', async () => {
    const store = memoryStore();
    const asked: [number, number, number, boolean][] = [];
    const makeStored = lookingFirst(store, async (i, j, after, text) => {
      asked.push([i, j, after, text]);
      const records = { ...emptyTile(i, j, { trees: [{ x: i, y: j }] }), version: after + 1 };
      // As `cityTile.worker.ts` does: written in the worker, its texts the ones it stored.
      const written = await writeTile(store, 'map', records);
      return { version: written.ok ? records.version : null, ...(text ? { prepared: prepareTile(records) } : {}) };
    });
    const generate = vi.fn(never);
    const tiles = new TileStore('map', storeTiles(store), generate, makeStored);
    const key = tileKey(-2, 6);
    const tile = await tiles.load(key);
    expect(asked).toEqual([[-2, 6, 0, true]]);
    expect(generate).not.toHaveBeenCalled();
    expect(tile).toEqual({ ...emptyTile(-2, 6, { trees: [{ x: -2, y: 6 }] }), version: 1 });
    // One write, the worker's: the page posted nothing to the store.
    expect(store.writes).toEqual([[`map:T:${key}`]]);
    // Loaded again: read, not made; a later write goes past it.
    expect(await tiles.load(key)).toEqual(tile);
    expect(asked).toHaveLength(1);
    expect(await tiles.write(tile)).toBe(2);
  });

  it('a tile stored in the older form is not made again: the save worker reads its version', async () => {
    const store = memoryStore();
    const old = { ...emptyTile(3, 3), version: 4 };
    // Written with no baker: no sections, the head not marked baked (`storedVersion` says 'legacy').
    await writeTile(store, 'map', old);
    expect(await storedVersion(store, 'map', old.key)).toBe('legacy');
    const made: number[] = [];
    const tiles = new TileStore('map', storeTiles(store), never, lookingFirst(store, async (i, j) => { made.push(tileKey(i, j)); return { version: 1 }; }));
    expect(await tiles.ensure(old.key)).toBe(4);
    expect(made).toEqual([]);
  });

  it('a region tile made and not stored is still handed to the page', async () => {
    const store = memoryStore();
    const makeStored = async (i: number, j: number, after: number): Promise<MadeTile> => {
      const records = { ...emptyTile(i, j), version: after + 1 };
      await writeTile(memoryStore(), 'other', records);
      return { version: null, prepared: prepareTile(records) };
    };
    const tiles = new TileStore('map', storeTiles(store), never, makeStored);
    expect((await tiles.load(tileKey(1, 2))).version).toBe(1);
    expect(store.blobs.size).toBe(0);
  });

  it('each write one past the last version the store knows', async () => {
    const store = memoryStore();
    const tiles = new TileStore('map', storeTiles(store), never);
    const tile = emptyTile(0, 0);
    await tiles.write(tile);
    await tiles.write(tile);
    expect((await tiles.read(tile.key))?.version).toBe(2);
    // A record read at a later version than the store has seen: one past it.
    await tiles.write({ ...tile, version: 5 });
    expect((await tiles.read(tile.key))?.version).toBe(6);
    // Another page's store learns the version by reading.
    const other = new TileStore('map', storeTiles(store), never);
    expect((await other.read(tile.key))?.version).toBe(6);
    await other.write(tile);
    expect((await tiles.read(tile.key))?.version).toBe(7);
    // Each write one transaction of one key.
    expect(store.writes.every((keys) => keys.length === 1)).toBe(true);
  });

  it('generates only a tile the store does not have, once', async () => {
    const store = memoryStore();
    const kept = emptyTile(1, 1, { nodes: [node(3, m(1_500), m(1_500))] });
    await new TileStore('map', storeTiles(store), never).write(kept);
    const generate = vi.fn((i: number, j: number) => Promise.resolve(emptyTile(i, j, { trees: [{ x: i, y: j }] })));
    const tiles = new TileStore('map', storeTiles(store), generate);
    expect((await tiles.load(kept.key)).nodes).toEqual(kept.nodes);
    expect(generate).not.toHaveBeenCalled();
    const missing = tileKey(-4, 9);
    // Two loads at once: the second finds what the first stored.
    const [a, b] = await Promise.all([tiles.load(missing), tiles.load(missing)]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(-4, 9);
    expect(a).toEqual(b);
    expect(a.version).toBe(1);
    expect(store.blobs.has(`map:T:${missing}`)).toBe(true);
    await tiles.load(missing);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never generates over a stored tile it cannot read', async () => {
    const store = memoryStore();
    const key = tileKey(0, 0);
    const broken = new Blob(['not a tile']);
    store.blobs.set(`map:T:${key}`, broken);
    const generate = vi.fn((i: number, j: number) => Promise.resolve(emptyTile(i, j)));
    await expect(new TileStore('map', storeTiles(store), generate).load(key)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect(store.blobs.get(`map:T:${key}`)).toBe(broken);
  });

  it('keeps the world\'s values under their own key', async () => {
    const store = memoryStore();
    const tiles = new TileStore('map', storeTiles(store), never);
    expect(await tiles.meta()).toBeNull();
    const meta: WorldMeta = { version: 1, generator: { seed: 9, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, markingStyle: 'european' };
    expect(await tiles.setMeta(meta)).toBe(true);
    expect(store.writes.at(-1)).toEqual(['map:world']);
    expect(await new TileStore('map', storeTiles(store), never).meta()).toEqual(meta);
  });

  it('empties the trees of a stored tile where it is stored, its version moved on, its other lists kept; nothing to clear, nothing written', async () => {
    const store = memoryStore();
    const tiles = new TileStore('map', storeTiles(store), never);
    const tree = { x: m(10), y: m(10), species: 0, scale: 1 } as unknown as TileRecords['trees'][number];
    const element = { kind: 'rock', x: m(20), y: m(20) } as unknown as TileRecords['elements'][number];
    const tile = emptyTile(0, 0, { trees: [tree, tree], elements: [element] });
    await tiles.write(tile);
    const writes = store.writes.length;
    const version = await tiles.clearLists(tile.key, ['trees']);
    expect(version).toBe(2);
    const back = (await new TileStore('map', storeTiles(store), never).read(tile.key))!;
    expect(back.trees).toEqual([]);
    expect(back.elements).toHaveLength(1);
    expect(back.version).toBe(2);
    expect(await tiles.clearLists(tile.key, ['trees'])).toBeNull();
    expect(store.writes.length).toBe(writes + 1);
    expect(await tiles.clearLists(tileKey(5, 5), ['trees'])).toBeNull();
  });

  it("writes a part of the world's values alone under its key, and reads it back over the values, a key it dropped gone", async () => {
    const store = memoryStore();
    const tiles = new TileStore('map', storeTiles(store), never);
    const meta: WorldMeta = { version: 1, generator: null, unit: 1, values: { terrain: [], economy: { balance: 5 }, weather: { rain: 1 } as never } };
    await tiles.setMeta(meta);
    expect(await tiles.setMetaParts({ economy: { economy: { balance: 7 } } })).toBe(true);
    expect(store.writes.at(-1)).toEqual(['map:world:economy']);
    expect((await tiles.meta())?.values).toEqual({ terrain: [], economy: { balance: 7 }, weather: { rain: 1 } });
    // Back at the starting balance the part holds no key: the value is gone.
    await tiles.setMetaParts({ economy: {} });
    expect((await new TileStore('map', storeTiles(store), never).meta())?.values).toEqual({ terrain: [], weather: { rain: 1 } });
  });
});

/** A house of the parametric generator in tile (0,0), as the generator writes it. */
const house = (id: number, x: number): Building => ({ ...generateBody('residential', m(20), m(20), 2), id, x, y: m(100), rotation: 0 }) as unknown as Building;

describe('a tile written', () => {
  it('posts its buildings as rows of their tables: an unchanged one its tile\'s row, a replaced one a table of its own made once', async () => {
    const base = tileIdBase(tileKey(0, 0));
    const prepared = prepareTile(emptyTile(0, 0, { buildings: [house(base, m(100)), house(base + 1, m(300)), house(base + 2, m(500))] }), false);
    const loaded = preparedRecords(prepared);
    const page = loaded.buildings as readonly Building[];
    // The player replaced the second: a new record, in no table yet.
    const now = { ...loaded, buildings: [page[0]!, { ...page[1]!, rotation: 1 }, page[2]!] };
    const write = tileWrite(now);
    expect(write.buildings.tables).toHaveLength(2);
    expect(write.buildings.tables[0]).toBe(prepared.buildings);
    expect([...write.buildings.table]).toEqual([0, 1, 0]);
    expect([...write.buildings.row]).toEqual([0, 0, 2]);
    // Written again: the replaced record's table is the one made the first time.
    expect(tileWrite(now).buildings.tables[1]).toBe(write.buildings.tables[1]);
    // Stored as JSON keeps the records, in the tile's order: the save's format unchanged.
    const store = memoryStore();
    expect(await storeTiles(store).run({ op: 'write', map: 'map', records: write })).toBe(true);
    expect((await readTile(store, 'map', now.key))!.buildings).toEqual(JSON.parse(JSON.stringify(now.buildings)));
  });

  it('a tile the generator just made and prepared: its buildings one table for them all', () => {
    const base = tileIdBase(tileKey(0, 0));
    const fresh = emptyTile(0, 0, { buildings: [house(base, m(100)), house(base + 1, m(300))] });
    const write = tileWrite(preparedRecords(prepareTile(fresh, false)));
    expect(write.buildings.tables).toHaveLength(1);
    expect([...write.buildings.table]).toEqual([0, 0]);
    expect([...write.buildings.row]).toEqual([0, 1]);
    expect(JSON.parse(JSON.stringify(writtenRecords(write).buildings))).toEqual(JSON.parse(JSON.stringify(fresh.buildings)));
    expect(tileWrite(emptyTile(0, 0)).buildings.tables).toEqual([]);
  });
});

/** Every tile a migration wrote, read back. */
/** Every tile as the store holds it (raw, `readTile`): `TileStore.read` would hand the records prepared, the buildings the page cannot read dropped. */
async function readAll(store: PartStore, keys: readonly number[]): Promise<TileRecords[]> {
  const out: TileRecords[] = [];
  for (const key of keys) out.push((await readTile(store, 'map', key))!);
  return out;
}

const ids = (list: readonly unknown[]): number[] => list.map((r) => (r as { id: number }).id).sort((a, b) => a - b);
const byId = (list: readonly unknown[] | undefined): unknown[] => [...(list ?? [])].sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);

/** The tiles hold the map: each record in exactly one tile, each road's and span's ends in its tile, own or borrowed. */
function expectUnion(read: readonly TileRecords[], doc: SerializedDoc): void {
  const all = <K extends 'nodes' | 'segments' | 'poles' | 'poleSpans' | 'buildings' | 'lots' | 'landscape' | 'barriers' | 'paint' | 'trees' | 'elements'>(field: K): unknown[] =>
    read.flatMap((t) => t[field] as readonly unknown[]);
  expect(byId(all('nodes'))).toEqual(byId(doc.nodes));
  expect(byId(all('segments'))).toEqual(byId(doc.segments));
  expect(byId(all('poles'))).toEqual(byId(doc.poles));
  expect(byId(all('poleSpans'))).toEqual(byId(doc.poleSpans));
  expect(byId(all('buildings'))).toEqual(byId(doc.buildings));
  expect(byId(all('lots'))).toEqual(byId(doc.lots));
  expect(byId(all('landscape'))).toEqual(byId(doc.landscape));
  expect(byId(all('barriers'))).toEqual(byId(doc.barriers));
  // Exactly once: no id twice among the tiles' own records.
  for (const field of ['nodes', 'segments', 'poles', 'poleSpans', 'buildings', 'lots', 'landscape', 'barriers'] as const) {
    const list = ids(all(field));
    expect(new Set(list).size).toBe(list.length);
  }
  expect(all('paint')).toHaveLength(doc.paint?.length ?? 0);
  expect(all('trees')).toHaveLength(doc.trees?.length ?? 0);
  expect(all('elements')).toHaveLength(doc.elements?.length ?? 0);
  for (const t of read) {
    const here = new Set([...t.nodes, ...t.borrowedNodes].map((n) => n.id));
    for (const s of t.segments) { expect(here.has(s.a)).toBe(true); expect(here.has(s.b)).toBe(true); }
    const poles = new Set([...t.poles, ...t.borrowedPoles].map((p) => p.id));
    for (const s of t.poleSpans) { expect(poles.has(s.a)).toBe(true); expect(poles.has(s.b)).toBe(true); }
    // A borrowed end is another tile's own record.
    const own = new Set(t.nodes.map((n) => n.id));
    for (const n of t.borrowedNodes) expect(own.has(n.id)).toBe(false);
  }
}

/** A small map in this build's unit whose road and wire cross tile edges. */
function smallMap(): SerializedDoc {
  const tiled = tileIdBase(tileKey(1, 0)) + 5;
  return {
    version: 1, unit: 1, markingStyle: 'european', economy: { balance: 5 }, weather: { rain: 1 },
    fog: { dabs: [{ x: 1, y: 1, radius: 3 }], settings: { density: 0.2 } }, gullies: { dabs: [], auto: 1 },
    nodes: [node(1, m(1_000), m(500)), node(2, m(1_100), m(500)), node(3, m(1_200), m(500)), node(tiled, m(1_300), m(500))],
    segments: [
      { id: 10, a: 1, b: 2, type: 0, curve: null },
      { id: 11, a: 2, b: 3, type: 0, curve: null },
      { id: 12, a: 3, b: tiled, type: 0, curve: null },
    ],
    poles: [{ id: 20, x: m(-10), y: m(10) }, { id: 21, x: m(30), y: m(10) }],
    poleSpans: [{ id: 30, a: 20, b: 21 }],
    buildings: [{ id: 40, x: m(50), y: m(50) }, { id: 41, x: m(-2_000), y: m(3_000) }] as never,
    lots: [{ id: 50, corners: [{ x: m(1_500), y: m(100) }, { x: m(1_520), y: m(100) }, { x: m(1_520), y: m(120) }, { x: m(1_500), y: m(120) }] }],
    lotKeys: ['b:375,25,5,5', 'odd'],
    landscape: [{ id: 60, kind: 'bench', x: m(-500), y: m(-500) }],
    barriers: [{ id: 70, kind: 'fence', points: [{ x: m(2_100), y: m(10) }, { x: m(2_200), y: m(10) }] }],
    paint: [{ kind: 'grass', x: m(10), y: m(10), radius: m(5), strength: 1 }],
    trees: [{ x: m(1_030), y: m(5), height: 8 }],
    elements: [{ x: m(5), y: m(5), kind: 'rock', size: 1 }],
    terrain: [{ id: 1, x: 0, y: 0, radius: m(10), strength: 1, mode: 'raise' } as never],
    zones: [{ x0: 0, y0: 0, x1: m(10), y1: m(10), use: 'residential' } as never],
  };
}

describe('a tile store of a tab that only reads the world', () => {
  it('writes nothing: a tile made is not stored, a write is refused, the maker that stores is never asked', async () => {
    const store = memoryStore();
    let stored = 0;
    const tiles = new TileStore('map', storeTiles(store), async (i, j) => emptyTile(i, j),
      async () => { stored++; return { version: 1 }; });
    tiles.readOnly = true;
    await tiles.load(tileKey(0, 0));
    expect(await tiles.write(emptyTile(1, 0))).toBeNull();
    expect(store.writes).toHaveLength(0);
    expect(stored).toBe(0);
  });
});

describe('a map saved before the tiles', () => {
  it("is migrated without another world's parts left in the store (its balance, zones, people)", async () => {
    const store = memoryStore();
    const doc = smallMap();
    store.blobs.set('map', new Blob([JSON.stringify({ version: 2, savedAt: 10, document: doc, settings: { camera: 1 } })]));
    // A part written apart by a world before, its whole gone.
    store.blobs.set('map:world:economy', new Blob([JSON.stringify({ economy: { balance: 123_456_789 } })]));
    const tiles = new TileStore('map', storeTiles(store), never);
    expect((await tiles.migrate()).outcome).toBe('migrated');
    expect(store.blobs.has('map:world:economy')).toBe(false);
    const meta = await tiles.meta();
    expect((meta?.values as { economy?: { balance?: number } } | undefined)?.economy?.balance).not.toBe(123_456_789);
  });

  it('is distributed into tiles whose union is the map, borrowed ends present', async () => {
    const store = memoryStore();
    const doc = smallMap();
    store.blobs.set('map', new Blob([JSON.stringify({ version: 2, savedAt: 10, document: doc, settings: { camera: 1 } })]));
    const tiles = new TileStore('map', storeTiles(store), never);
    const report = await tiles.migrate();
    expect(report.outcome).toBe('migrated');
    expect(report.from).toBe('large');
    // One transaction: every tile and the world's values, the values last.
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.at(-1)).toBe('map:world');
    const read = await readAll(store, report.keys);
    expectUnion(read, doc);
    const east = read.find((t) => t.key === tileKey(1, 0))!;
    // The road from tile (0,0) to (1,0) is (1,0)'s (its middle), its west end borrowed.
    expect(east.segments.map((s) => s.id)).toContain(10);
    expect(east.borrowedNodes.map((n) => n.id)).toEqual([1]);
    // The wire's west pole is borrowed by the tile of its middle.
    expect(read.find((t) => t.key === tileKey(0, 0))!.borrowedPoles.map((p) => p.id)).toEqual([20]);
    expect(east.lots.map((l) => l.id)).toEqual([50]);
    expect(east.lotKeys).toEqual(['b:375,25,5,5']);
    expect(east.trees).toHaveLength(1);
    // Ids kept; a pre-tile map's ids are outside every range, an id in the tile's range is counted past.
    const base = tileIdBase(east.key);
    expect(east.next.node).toBe(base + 6);
    expect(east.next.segment).toBe(base);
    expect(east.next.node - base).toBeLessThan(TILE_COUNTED);
    expect(read.every((t) => t.version === 1)).toBe(true);
    const meta = (await tiles.meta())!;
    expect(meta.generator).toBeNull();
    expect(meta.markingStyle).toBe('european');
    expect(meta.economy).toEqual({ balance: 5 });
    expect(meta.fog).toEqual({ density: 0.2 });
    expect(meta.gullyAuto).toBe(1);
    expect(meta.settings).toEqual({ camera: 1 });
    expect(meta.held?.terrain).toEqual(doc.terrain);
    expect(meta.held?.zones).toEqual(doc.zones);
    expect(meta.held?.fog).toEqual(doc.fog?.dabs);
    expect(meta.held?.lotKeys).toEqual(['odd']);
  });

  it('a map saved by squares (manifest 5): the tiles hold it, its keys left as they were', async () => {
    const store = memoryStore();
    const town = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')) as SerializedDoc);
    expect(await new TiledSaves(store, 'map').save(town, { camera: 2 }, 77)).toBe(true);
    const saved = (await new TiledSaves(store, 'map').read())!.document;
    const before = new Map(store.blobs);
    const tiles = new TileStore('map', storeTiles(store), never);
    const report = await tiles.migrate();
    expect(report.outcome).toBe('migrated');
    expect(report.from).toBe('tiles');
    expect(report.keys.length).toBeGreaterThan(1);
    expectUnion(await readAll(store, report.keys), saved);
    // The old keys untouched: the same blobs, none removed; only tiles and the world's values added.
    for (const [key, blob] of before) expect(store.blobs.get(key)).toBe(blob);
    for (const key of store.blobs.keys()) if (!before.has(key)) expect(key === 'map:world' || key.startsWith('map:T:')).toBe(true);
    expect((await tiles.meta())?.settings).toEqual({ camera: 2 });
    // Once stored, never again: a second migration writes nothing.
    const writes = store.writes.length;
    expect((await tiles.migrate()).outcome).toBe('present');
    expect(store.writes).toHaveLength(writes);
  });

  it('the newest copy is the one distributed, the page\'s text among them', async () => {
    const store = memoryStore();
    const older = { ...smallMap(), markingStyle: 'classic' };
    store.blobs.set('map', new Blob([JSON.stringify({ version: 2, savedAt: 10, document: older, settings: {} })]));
    const local = JSON.stringify({ version: 2, savedAt: 20, document: smallMap(), settings: { camera: 3 } });
    const report = await new TileStore('map', storeTiles(store), never).migrate(local);
    expect(report.from).toBe('local');
    expect((await new TileStore('map', storeTiles(store), never).meta())?.markingStyle).toBe('european');
  });

  it('no map saved: nothing written', async () => {
    const store = memoryStore();
    expect((await new TileStore('map', storeTiles(store), never).migrate(null)).outcome).toBe('none');
    expect(store.writes).toHaveLength(0);
  });
});

describe("a stored tile's bays added after the map is made (`TileStore.addBays`)", () => {
  it("asks the maker for the bays alone, on the tile's chain: a write of the tile asked meanwhile waits for it", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const maker = (_i: number, _j: number, _after: number, _records: boolean, _ifMissing: boolean, baysOnly?: boolean): Promise<MadeTile> => {
      order.push(baysOnly ? 'bays' : 'made');
      return new Promise((done) => { release = () => done({ version: 1 }); });
    };
    const backend = { run: vi.fn(async (op: { op: string }) => { order.push(op.op); return op.op === 'write' ? true : null; }) };
    const store = new TileStore('map', backend as never, () => Promise.reject(new Error('not made here')), maker);
    const key = tileKey(2, 3);
    const bays = store.addBays(key);
    const base = tileIdBase(key);
    const written = store.write({
      key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
      landscape: [], barriers: [], paint: [], trees: [], elements: [],
      next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['bays']);
    release();
    await bays;
    await written;
    expect(order).toEqual(['bays', 'write']);
  });
});

