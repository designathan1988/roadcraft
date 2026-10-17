import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { TileRecords } from '@world/doc';
import { TILE, tileIdBase, tileKey, tileOfKey } from '@world/tiles';
import { MAP_TILES, tileOnMap } from '@world/cityGen/wholeMap';
import { WorldStreamer } from '@/worldStreamer';

/** THE ACTIVE REGION'S STREAMER (`worldStreamer.ts`): the region's tiles first, then the ring it loads next, then every other tile of the map. */

function emptyTile(key: number): TileRecords {
  const base = tileIdBase(key);
  return {
    key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

/** A store whose tiles made ahead wait to be let through by the test. */
function source(): { loads: number[]; ensures: number[]; finish(key: number): void; load(key: number): Promise<TileRecords>; ensure(key: number): Promise<number>; write(): Promise<number> } {
  const pending = new Map<number, (version: number) => void>();
  const s = {
    loads: [] as number[],
    ensures: [] as number[],
    finish(key: number) { pending.get(key)?.(1); pending.delete(key); },
    load(key: number) { s.loads.push(key); return Promise.resolve(emptyTile(key)); },
    ensure(key: number) { s.ensures.push(key); return new Promise<number>((done) => pending.set(key, done)); },
    write: () => Promise.resolve(1),
  };
  return s;
}

const turns = async (n: number): Promise<void> => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };
/** How far a tile is from the origin's, in tiles. */
const ring = (key: number): number => { const { i, j } = tileOfKey(key); return Math.max(Math.abs(i), Math.abs(j)); };

describe('the streamer', () => {
  it('makes nothing ahead before the region is in, then the ring several at once, then the rest of the map nearest first', async () => {
    const doc = new RoadDoc();
    const store = source();
    const streamer = new WorldStreamer(doc, store);
    streamer.focus(0, 0);
    // The region's own tiles, nothing ahead while they come.
    for (let frame = 0; frame < 30 && !streamer.settled; frame++) {
      expect(store.ensures).toEqual([]);
      await turns(1);
      streamer.focus(0, 0);
      streamer.apply(frame);
    }
    expect(streamer.settled).toBe(true);
    expect(new Set(store.loads).size).toBe(9);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) expect(doc.hasTile(tileKey(i, j))).toBe(true);
    // The ring next, four at once, never a region tile.
    expect(store.ensures).toHaveLength(4);
    expect(store.ensures.every((key) => ring(key) === 2)).toBe(true);
    for (let round = 0; round < 4; round++) {
      for (const key of [...store.ensures]) store.finish(key);
      await turns(2);
    }
    expect(store.ensures.filter((key) => ring(key) === 2)).toHaveLength(16);
    // Past the ring: every other tile of the map, nearest first, one lane kept free for the camera's next tiles.
    const past = (): number[] => store.ensures.filter((key) => ring(key) > 2);
    expect(past().length).toBeLessThanOrEqual(3);
    for (let round = 0; round < 40; round++) {
      for (const key of [...store.ensures]) store.finish(key);
      await turns(2);
    }
    expect(new Set(store.ensures).size).toBe(MAP_TILES * MAP_TILES - 9);
    expect(store.ensures.every((key) => { const { i, j } = tileOfKey(key); return tileOnMap(i, j); })).toBe(true);
    expect(store.ensures.some((key) => ring(key) <= 1)).toBe(false);
    // Nearest first: no tile asked before one nearer the camera.
    const rings = store.ensures.map(ring);
    for (let k = 1; k < rings.length; k++) expect(rings[k]!).toBeGreaterThanOrEqual(rings[k - 1]!);
  });

  it('makes the whole map while the opening waits for it (`rush`): every lane the region leaves free, nearest first, counted to the last tile', async () => {
    const doc = new RoadDoc();
    const store = source();
    const streamer = new WorldStreamer(doc, store, {}, 4);
    streamer.rush = true;
    streamer.focus(0, 0);
    expect(streamer.mapTotal).toBe(MAP_TILES * MAP_TILES);
    await turns(1);
    // Before the region is put in, the lanes it leaves free already make the map: never more than the lanes at once.
    expect(doc.loadedTiles.size).toBe(0);
    expect(store.ensures.length).toBeGreaterThan(0);
    expect(store.ensures.length).toBeLessThanOrEqual(4);
    for (let round = 0; round < 80 && streamer.mapMade < streamer.mapTotal; round++) {
      for (const key of [...store.ensures]) store.finish(key);
      await turns(2);
      streamer.focus(0, 0);
      streamer.apply(round);
    }
    expect(streamer.mapMade).toBe(streamer.mapTotal);
    // Ahead tiles asked before the region was in: the lanes it left free were used.
    expect(store.ensures.length).toBe(MAP_TILES * MAP_TILES - 9);
    expect(store.ensures.some((key) => ring(key) <= 1)).toBe(false);
  });
});

describe('the active region and the kept ring', () => {
  it('tells which loaded tiles left the 3 x 3 for the ring or came back, with their rectangles', async () => {
    const doc = new RoadDoc();
    const store = source();
    const flips: { keys: number[]; rects: number[][] }[] = [];
    const streamer = new WorldStreamer(doc, store, { activeChanged: (keys, rects) => flips.push({ keys: [...keys], rects: rects.map((r) => [...r]) }) });
    streamer.focus(0, 0);
    for (let frame = 0; frame < 30 && !streamer.settled; frame++) { await turns(1); streamer.focus(0, 0); streamer.apply(frame); }
    expect(streamer.settled).toBe(true);
    expect(flips).toEqual([]);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) expect(streamer.isActive(tileKey(i, j))).toBe(true);
    // One tile east, well past the edge (`RECENTRE_PAST`): the west column (i = -1) is kept in the ring, not active; the east column (i = 2) is active and not loaded yet.
    streamer.focus(1024 + 300, 10);
    expect(flips).toHaveLength(1);
    expect(new Set(flips[0]!.keys)).toEqual(new Set([-1, 0, 1].map((j) => tileKey(-1, j))));
    expect(flips[0]!.rects).toContainEqual([-1024, 0, 0, 1024]);
    for (let j = -1; j <= 1; j++) { expect(streamer.isActive(tileKey(-1, j))).toBe(false); expect(doc.hasTile(tileKey(-1, j))).toBe(true); expect(streamer.isActive(tileKey(2, j))).toBe(true); }
    // Back west: the same column active again, the east column (not loaded) told of nothing.
    streamer.focus(10, 10);
    expect(flips).toHaveLength(2);
    expect(new Set(flips[1]!.keys)).toEqual(new Set([-1, 0, 1].map((j) => tileKey(-1, j))));
  });
});

/** A store that runs each tile's calls in order, as `TileStore` does; its writes can be held and made to fail. */
function chainedStore() {
  const stored = new Map<number, TileRecords>();
  const chains = new Map<number, Promise<unknown>>();
  const gates: (() => void)[] = [];
  const s = {
    stored, held: false, failures: 0, writes: 0,
    release() { for (const open of gates.splice(0)) open(); },
    chained<T>(key: number, run: () => Promise<T>): Promise<T> {
      const done = (chains.get(key) ?? Promise.resolve()).then(run);
      chains.set(key, done.then(() => undefined, () => undefined));
      return done;
    },
    load(key: number) { return s.chained(key, async () => stored.get(key) ?? emptyTile(key)); },
    write(records: TileRecords) {
      return s.chained(records.key, async () => {
        s.writes++;
        if (s.held) await new Promise<void>((open) => gates.push(open));
        if (s.failures > 0) { s.failures--; return null; }
        const version = (stored.get(records.key)?.version ?? 1) + 1;
        stored.set(records.key, { ...records, version });
        return version;
      });
    },
  };
  return s;
}

/** Frames until every tile the camera at (x, y) wants is in. */
async function settle(streamer: WorldStreamer, x: number, y: number): Promise<void> {
  for (let frame = 0; frame < 60; frame++) {
    streamer.focus(x, y);
    streamer.apply(frame);
    if (streamer.settled) return;
    await turns(1);
  }
}

describe('the tiles written', () => {
  const far = 4 * TILE + 10;
  const edited = (doc: RoadDoc): boolean => [...doc.nodes.values()].some((n) => n.x === 100 && n.y === 100);

  it('reads a tile let go and asked again at the version its write holds, the write still under way', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    // Lanes for every tile at once: the tile is asked again the moment the camera is back.
    const streamer = new WorldStreamer(doc, store, {}, 64);
    await settle(streamer, 10, 10);
    doc.addNode({ x: 100, y: 100 });
    store.held = true;
    // Away and straight back: the tile goes out with its write held, and is asked again before the write lands.
    streamer.focus(far, 10);
    // One tile let go a frame: frames until this one is.
    for (let f = 0; f < 20 && doc.hasTile(tileKey(0, 0)); f++) streamer.apply(1000 + f);
    expect(doc.hasTile(tileKey(0, 0))).toBe(false);
    streamer.focus(10, 10);
    store.held = false;
    store.release();
    await settle(streamer, 10, 10);
    expect(doc.hasTile(tileKey(0, 0))).toBe(true);
    expect(edited(doc)).toBe(true);
  });

  it('keeps a tile whose write failed: asked again it is served what was written, and written again', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const failed: string[] = [];
    const streamer = new WorldStreamer(doc, store, { failed: (why) => failed.push(why) });
    await settle(streamer, 10, 10);
    doc.addNode({ x: 100, y: 100 });
    store.failures = 1;
    streamer.focus(far, 10);
    streamer.apply(1000);
    await turns(3);
    expect(failed.length).toBe(1);
    expect(edited(RoadDoc.fromJSON({ version: 1, nodes: store.stored.get(tileKey(0, 0))?.nodes ?? [], segments: [] }))).toBe(false);
    await settle(streamer, 10, 10);
    expect(edited(doc)).toBe(true);
    // Written again from the page: the store holds the edit.
    expect(await streamer.flush()).toBe(true);
    expect(store.stored.get(tileKey(0, 0))!.nodes.some((n) => n.x === 100 && n.y === 100)).toBe(true);
  });

  it('flushes only once the store confirmed every write, and writes a failed one again', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const streamer = new WorldStreamer(doc, store);
    await settle(streamer, 10, 10);
    doc.addNode({ x: 100, y: 100 });
    store.held = true;
    store.failures = 1;
    let result: boolean | null = null;
    void streamer.flush().then((ok) => { result = ok; });
    await turns(3);
    expect(result).toBeNull();
    store.held = false;
    store.release();
    await turns(3);
    expect(result).toBe(false);
    expect(await streamer.flush()).toBe(true);
    expect(store.stored.get(tileKey(0, 0))!.nodes.some((n) => n.x === 100 && n.y === 100)).toBe(true);
  });

  it('writes an edit at the next frame, not seconds later, and an edit made during a write right after it', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    let worldWrites = 0;
    const streamer = new WorldStreamer(doc, store, { writeWorld: () => { worldWrites++; return Promise.resolve(true); } });
    await settle(streamer, 10, 10);
    const before = store.writes;
    doc.addNode({ x: 100, y: 100 });
    doc.setBalance(doc.economy.balance - 1);
    store.held = true;
    // The next frame, a few milliseconds on: the tile posted (the world's values after it).
    streamer.apply(1);
    await turns(1);
    expect(store.writes).toBe(before + 1);
    // Another edit while the write is held: not posted beside it, written once it is in.
    doc.addNode({ x: 200, y: 100 });
    streamer.apply(2);
    await turns(2);
    expect(store.writes).toBe(before + 1);
    store.held = false;
    store.release();
    await turns(3);
    streamer.apply(3);
    await turns(3);
    expect(store.writes).toBe(before + 2);
    expect(worldWrites).toBe(1);
    expect(store.stored.get(tileKey(0, 0))!.nodes.some((n) => n.x === 200 && n.y === 100)).toBe(true);
  });
});

describe('tiles let go', () => {
  it('lets one go a frame, the farthest first, when the camera jumps far', async () => {
    const doc = new RoadDoc();
    const letGo: number[] = [];
    const streamer = new WorldStreamer(doc, chainedStore(), { letGo: (key) => letGo.push(key) });
    await settle(streamer, 10, 10);
    const before = doc.loadedTiles.size;
    expect(before).toBeGreaterThan(1);
    streamer.focus(10 * TILE, 10 * TILE);
    streamer.apply(100);
    expect(letGo).toHaveLength(1);
    streamer.apply(101);
    expect(letGo).toHaveLength(2);
  });
});

describe('the active region along a tile edge', () => {
  it('is centred on the next tile only once the camera is well past the edge, and back only once well past it again', async () => {
    const doc = new RoadDoc();
    const flips: number[][] = [];
    const streamer = new WorldStreamer(doc, chainedStore(), { activeChanged: (keys) => flips.push([...keys]) });
    await settle(streamer, TILE / 2, TILE / 2);
    flips.length = 0;
    // Back and forth over the east edge, a few metres each way: the region stays.
    for (const dx of [10, -10, 40, -40, 100, -20]) { streamer.focus(TILE + dx, TILE / 2); streamer.apply(1); }
    expect(flips).toEqual([]);
    expect(streamer.isActive(tileKey(-1, 0))).toBe(true);
    // Well past it: centred on the next tile.
    streamer.focus(TILE + 300, TILE / 2);
    expect(streamer.isActive(tileKey(-1, 0))).toBe(false);
    expect(streamer.isActive(tileKey(2, 0))).toBe(true);
    // A little back over the edge: still there.
    streamer.focus(TILE - 50, TILE / 2);
    expect(streamer.isActive(tileKey(2, 0))).toBe(true);
  });
});

describe('the streamer under a long world build', () => {
  it('writes an edit while the world is being built (`save`), putting no tile in meanwhile', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const streamer = new WorldStreamer(doc, store);
    await settle(streamer, 10, 10);
    const before = store.writes;
    const loaded = doc.loadedTiles.size;
    doc.addNode({ x: 100, y: 100 });
    // The camera on: tiles ahead come ready, the build still running (main.ts calls `save`, not `apply`).
    streamer.focus(TILE * 3, 0);
    await turns(3);
    streamer.save(1);
    await turns(2);
    expect(store.writes).toBe(before + 1);
    expect(store.stored.get(tileKey(0, 0))!.nodes.some((n) => n.x === 100 && n.y === 100)).toBe(true);
    expect(doc.loadedTiles.size).toBe(loaded);
  });
});

describe('a whole map clear', () => {
  it('empties the lists of a tile that comes while it runs (read before its clear), and writes it so', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const tree = { x: 100, y: 100, height: 8, yaw: 0, seed: 0.3 } as TileRecords['trees'][number];
    store.stored.set(tileKey(0, 0), { ...emptyTile(tileKey(0, 0)), trees: [tree] });
    const streamer = new WorldStreamer(doc, store);
    const done = streamer.clearing(['trees']);
    await settle(streamer, 10, 10);
    expect(doc.hasTile(tileKey(0, 0))).toBe(true);
    expect(doc.trees).toHaveLength(0);
    done();
    expect(await streamer.flush()).toBe(true);
    expect(store.stored.get(tileKey(0, 0))!.trees).toEqual([]);
  });
});

describe('a failed write and a clear', () => {
  it('posts the failed write again without the lists the clear emptied', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const streamer = new WorldStreamer(doc, store);
    await settle(streamer, 10, 10);
    doc.plantTrees([{ x: 100, y: 100, height: 8, yaw: 0, seed: 0.3 }]);
    expect(doc.trees).toHaveLength(1);
    // Its write fails, then the tile is let go: only the failed write's records hold it.
    // Every write of it fails (the one of the edit, the one as it is let go): only the failed write's records hold it.
    store.failures = 99;
    streamer.apply(1);
    await turns(3);
    streamer.focus(8 * TILE, 0);
    for (let f = 0; f < 4; f++) { streamer.apply(2 + f); await turns(2); }
    expect(doc.hasTile(tileKey(0, 0))).toBe(false);
    store.failures = 0;
    // The trees cleared over the whole map, in the store as `clearLists` does; then the retry.
    const done = streamer.clearing(['trees']);
    for (const [key, t] of store.stored) store.stored.set(key, { ...t, trees: [] });
    done();
    expect(await streamer.flush()).toBe(true);
    expect(store.stored.get(tileKey(0, 0))!.trees).toEqual([]);
  });
});

describe('a tile read before a clear', () => {
  it('comes in without the lists even when it is put in after the clear is done', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const tree = { x: 100, y: 100, height: 8, yaw: 0, seed: 0.3 } as TileRecords['trees'][number];
    store.stored.set(tileKey(0, 0), { ...emptyTile(tileKey(0, 0)), trees: [tree] });
    const streamer = new WorldStreamer(doc, store);
    // Asked (its read on its way, with the tree), then the clear begun and done before it is put in.
    streamer.focus(10, 10);
    const done = streamer.clearing(['trees']);
    done();
    await settle(streamer, 10, 10);
    expect(doc.hasTile(tileKey(0, 0))).toBe(true);
    expect(doc.trees).toHaveLength(0);
  });
});

describe('two whole map clears at once', () => {
  it('empties each list until its own clear is done: a clear of another list does not end it', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const tree = { x: 100, y: 100, height: 8, yaw: 0, seed: 0.3 } as TileRecords['trees'][number];
    store.stored.set(tileKey(0, 0), { ...emptyTile(tileKey(0, 0)), trees: [tree] });
    const streamer = new WorldStreamer(doc, store);
    // The trees' clear running, then the elements' started: the trees still emptied.
    const trees = streamer.clearing(['trees']);
    const elements = streamer.clearing(['elements']);
    // And a clear of the trees done twice (its answer and its failure) counts once.
    const again = streamer.clearing(['trees']);
    again();
    again();
    await settle(streamer, 10, 10);
    expect(doc.hasTile(tileKey(0, 0))).toBe(true);
    expect(doc.trees).toHaveLength(0);
    trees();
    elements();
  });
});

describe('a world another tab holds', () => {
  it('is read and never written from this tab: no tile, no value, and its flush says all is well', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    let worldWrites = 0;
    const streamer = new WorldStreamer(doc, store, { writeWorld: () => { worldWrites++; return Promise.resolve(true); } });
    streamer.readOnly = true;
    await settle(streamer, 10, 10);
    const before = store.writes;
    doc.addNode({ x: 100, y: 100 });
    doc.setBalance(doc.economy.balance - 5);
    streamer.apply(1);
    expect(await streamer.flush()).toBe(true);
    await turns(3);
    expect(store.writes).toBe(before);
    expect(worldWrites).toBe(0);
  });
});

describe("the world's values", () => {
  it('are written by the part that changed, never all of them for one', async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    const written: (readonly string[])[] = [];
    const streamer = new WorldStreamer(doc, store, { writeWorld: (parts) => { written.push([...parts]); return Promise.resolve(true); } });
    await settle(streamer, 10, 10);
    await turns(2);
    written.length = 0;
    doc.setBalance(doc.economy.balance - 100);
    streamer.apply(1);
    await turns(3);
    expect(written).toEqual([['economy']]);
  });
});

describe("the map's own allocators", () => {
  it("are written with the world's values when a record made where no tile is loaded moves them", async () => {
    const doc = new RoadDoc();
    const store = chainedStore();
    let worldWrites = 0;
    const streamer = new WorldStreamer(doc, store, { writeWorld: () => { worldWrites++; return Promise.resolve(true); } });
    await settle(streamer, 10, 10);
    await turns(2);
    const before = worldWrites;
    // Far past the region: no tile loaded there, the map's allocator gives the id.
    doc.addNode({ x: 4 * TILE + 10, y: 10 });
    streamer.apply(1);
    await turns(3);
    expect(worldWrites).toBe(before + 1);
  });
});

describe('an edited tile', () => {
  it('is behind in the store from the edit until a write holding it is confirmed: drawn from the page meanwhile (`pageEdit`, `pageRecords`)', async () => {
    const doc = new RoadDoc();
    const store = source();
    const writes: ((version: number) => void)[] = [];
    // Each write waits to be let through by the test.
    const slow = { ...store, write: () => new Promise<number>((done) => writes.push(done)) };
    const streamer = new WorldStreamer(doc, slow);
    streamer.focus(10, 10);
    for (let frame = 0; frame < 30 && !streamer.settled; frame++) { await turns(1); streamer.focus(10, 10); streamer.apply(frame); }
    const key = tileKey(0, 0);
    expect(streamer.pageEdit(key)).toBe(0);
    // A road's end laid in the tile: the store is behind from now on, the page's records hold it.
    const laid = doc.addNode({ x: 300, y: 400 });
    const first = streamer.pageEdit(key);
    expect(first).toBeGreaterThan(0);
    expect(streamer.pageRecords(key)!.nodes.map((n) => n.id)).toContain(laid.id);
    expect(streamer.pageEdit(tileKey(1, 1))).toBe(0);
    // Written: still behind until the store says it wrote it, and behind again by an edit made meanwhile.
    void streamer.flush();
    await turns(2);
    expect(writes.length).toBeGreaterThan(0);
    expect(streamer.pageEdit(key)).toBe(first);
    doc.addNode({ x: 320, y: 410 });
    const second = streamer.pageEdit(key);
    expect(second).toBeGreaterThan(first);
    writes.shift()!(2);
    await turns(2);
    expect(streamer.pageEdit(key)).toBe(second);
    // The write of the second edit confirmed: the store holds the tile as the page has it.
    void streamer.flush();
    await turns(2);
    while (writes.length) writes.shift()!(3);
    await turns(2);
    expect(streamer.pageEdit(key)).toBe(0);
  });
});
