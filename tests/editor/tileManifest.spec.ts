import { describe, expect, it } from 'vitest';
import type { PartStore } from '@editor/saveStore';
import { tileBlobKey, tileMarkKey } from '@editor/tileBlob';
import { type TileOp, TileStore, runTileOp, storeTiles } from '@editor/tileStore';
import { RoadDoc } from '@world/doc';
import type { TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { MAP_TILES } from '@world/cityGen/wholeMap';
import { WorldStreamer, mapTilesFrom } from '@/worldStreamer';

/** THE WORLD'S MANIFEST (`TileStore.manifest`): every stored tile known by one read of the marks written with the tiles, at the opening, however many tiles the world has - DO NOT ask the store for each tile (a round trip a tile: 100 at 10 km, 1,600 at 40) */

type Counted = PartStore & { gets: number; markReads: number; readonly values: Map<string, Blob | string> };

/** An IndexedDB stand-in with marks (a key range read in one call), counting the reads. */
function countedStore(): Counted {
  const values = new Map<string, Blob | string>();
  const store: Counted = {
    values, gets: 0, markReads: 0,
    async get(keys) { store.gets++; return keys.map((k) => { const v = values.get(k); return v instanceof Blob ? v : null; }); },
    async write(put, remove, marks) {
      for (const [k, b] of put) values.set(k, b);
      for (const [k, t] of marks ?? []) values.set(k, t);
      for (const k of remove) values.delete(k);
      return true;
    },
    async marks(prefix) {
      store.markReads++;
      return [...values].filter((e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string');
    },
  };
  return store;
}

/** Counts the calls of the tile store as they reach its backend. */
function countedBackend(store: PartStore): { run(op: TileOp): Promise<unknown>; readonly ops: string[] } {
  const ops: string[] = [];
  const bake = (): Readonly<Record<string, { json: unknown }>> => ({ mark: { json: 1 } });
  return { ops, run: (op) => { ops.push(op.op); return runTileOp(store, op, bake); } };
}

function emptyTile(key: number, version = 0): TileRecords {
  const base = tileIdBase(key);
  return {
    key, version, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

const never = (): Promise<TileRecords> => Promise.reject(new Error('no tile should be generated'));

/** A store holding `count` tiles of the map, written as the game writes them (baked). */
async function storedWorld(count: number): Promise<{ store: Counted; keys: number[] }> {
  const store = countedStore();
  const tiles = new TileStore('map', countedBackend(store), never);
  const keys = mapTilesFrom(0, 0).slice(0, count);
  for (const key of keys) await tiles.write(emptyTile(key));
  return { store, keys };
}

describe("the world's manifest", () => {
  it('knows every stored tile and its version by one read, the same for 4 tiles or 64', async () => {
    for (const count of [4, 64]) {
      const { store, keys } = await storedWorld(count);
      store.gets = 0;
      const backend = countedBackend(store);
      const reopened = new TileStore('map', backend, never);
      const manifest = await reopened.manifest();
      expect(manifest && [...manifest.keys()].sort()).toEqual([...keys].sort());
      for (const key of keys) expect(manifest!.get(key)).toBe(1);
      // One call, one read of the marks, no tile's blob read: independent of the number of tiles.
      expect(backend.ops).toEqual(['marks']);
      expect(store.markReads).toBe(1);
      expect(store.gets).toBe(0);
    }
  });

  it('leaves out a tile stored without its sections (it is ensured, and baked), and one taken away', async () => {
    const { store, keys } = await storedWorld(3);
    const page = new TileStore('map', storeTiles(store), never);
    // Written by the page with no sections: the maker bakes it after.
    await runTileOp(store, { op: 'write', map: 'map', unbaked: true, records: { ...emptyTile(keys[0]!, 5), buildings: { tables: [], table: new Uint32Array(0), row: new Uint32Array(0) } } });
    await runTileOp(store, { op: 'removeTiles', map: 'map', keys: [keys[1]!] });
    expect(store.values.has(tileMarkKey('map', keys[1]!))).toBe(false);
    const manifest = await page.manifest();
    expect([...manifest!.keys()]).toEqual([keys[2]]);
  });

  it('learns a tile stored before marks were the first time it is asked for, then knows it with the others', async () => {
    const { store, keys } = await storedWorld(2);
    // As a store written before marks: the tiles' blobs alone.
    store.values.delete(tileMarkKey('map', keys[0]!));
    expect(store.values.has(tileBlobKey('map', keys[0]!))).toBe(true);
    const page = new TileStore('map', countedBackend(store), never);
    expect([...(await page.manifest())!.keys()]).toEqual([keys[1]]);
    expect(await page.ensure(keys[0]!)).toBe(1);
    const again = new TileStore('map', countedBackend(store), never);
    expect([...(await again.manifest())!.keys()].sort()).toEqual([...keys].sort());
  });

  it('is null where the store keeps no marks: each tile asked as before', async () => {
    const store = countedStore();
    const bare: PartStore = { get: store.get, write: store.write };
    expect(await new TileStore('map', storeTiles(bare), never).manifest()).toBeNull();
  });
});

describe('the streamer reopening a world', () => {
  /** A store whose manifest names `stored`, counting the tiles asked one by one. */
  function reopening(stored: ReadonlyMap<number, number>) {
    const s = {
      ensures: [] as number[], manifests: 0,
      manifest() { s.manifests++; return Promise.resolve(stored); },
      load: (key: number) => Promise.resolve(emptyTile(key, 1)),
      ensure(key: number) { s.ensures.push(key); return Promise.resolve(1); },
      write: () => Promise.resolve(1),
    };
    return s;
  }
  const turns = async (n: number): Promise<void> => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };

  async function open(stored: ReadonlyMap<number, number>): Promise<{ store: ReturnType<typeof reopening>; streamer: WorldStreamer }> {
    const doc = new RoadDoc();
    const store = reopening(stored);
    const streamer = new WorldStreamer(doc, store);
    streamer.rush = true;
    for (let frame = 0; frame < 200 && streamer.mapMade < streamer.mapTotal; frame++) {
      streamer.focus(0, 0);
      streamer.apply(frame);
      await turns(1);
    }
    return { store, streamer };
  }

  it('asks no tile of a world stored whole: the map known from the manifest, read once', async () => {
    const all = new Map(mapTilesFrom(0, 0).map((key) => [key, 3] as const));
    const { store, streamer } = await open(all);
    expect(streamer.mapMade).toBe(MAP_TILES * MAP_TILES);
    expect(store.manifests).toBe(1);
    expect(store.ensures).toEqual([]);
  });

  it('asks only the tiles the manifest lacks', async () => {
    const order = mapTilesFrom(0, 0);
    const missing = [order[40]!, order[order.length - 1]!, tileKey(4, 4)];
    const stored = new Map(order.filter((key) => !missing.includes(key)).map((key) => [key, 3] as const));
    const { store, streamer } = await open(stored);
    expect(streamer.mapMade).toBe(MAP_TILES * MAP_TILES);
    expect(store.manifests).toBe(1);
    expect(new Set(store.ensures)).toEqual(new Set(missing));
  });
});
