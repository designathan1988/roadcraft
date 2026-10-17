import { describe, expect, it, vi } from 'vitest';
import type { PartStore } from '@editor/saveStore';
import { type TileOp, TileStore, type WorldMeta, runTileOp, storeTiles } from '@editor/tileStore';
import { type WorldFile, WorldFileScanner, openWorldFile, saveWorldFile, worldFilePieces } from '@editor/worldExport';
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

/** A file's value opened as the game opens a file: read as a stream (`openWorldFile`). */
const opened = (value: unknown): Promise<WorldFile | null> => openWorldFile(new Blob([JSON.stringify(value)]));

/** Every tile of an opened file, in order. */
async function tilesOf(file: WorldFile): Promise<TileRecords[]> {
  const out: TileRecords[] = [];
  expect(await file.eachTile(async (t) => { out.push(t); return true; })).toBe(true);
  return out;
}

/** Tiles handed to `importWorld` one at a time, as a file's are. */
const each = (tiles: readonly TileRecords[]) => async (take: (records: TileRecords) => Promise<boolean>): Promise<boolean> => {
  for (const t of tiles) if (!(await take(t))) return false;
  return true;
};

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
    const file = await openWorldFile(new Blob(pieces));
    expect(file).not.toBeNull();
    expect(file!.meta).toEqual(meta);
    const read = await tilesOf(file!);
    expect(read.map((t) => t.key)).toEqual(tiles.map((t) => t.key));
    const into = new TileStore('map', storeTiles(memoryStore()), never);
    await into.setMeta(file!.meta);
    for (const t of read) await into.write(t);
    for (const t of tiles) {
      const back = (await into.read(t.key))!;
      expect(back.nodes).toEqual(t.nodes);
      expect(back.trees).toEqual(t.trees);
    }
    expect((await into.meta())?.values).toEqual(meta.values);
  });

  it('is not taken for a map file of another kind', async () => {
    expect(await opened({ version: 2, document: {} })).toBeNull();
    expect(await opened({ version: 3, world: { version: 1, unit: 1, generator: null }, tiles: [] })).toBeNull();
  });

  it('refuses a file whose tile lacks a list or a counter, or lies off the map', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    await from.write(tile(0, 0));
    const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} };
    await from.setMeta(meta);
    const text = await new Blob(await worldFilePieces((await from.meta())!, [tileKey(0, 0)], (key) => from.readText(key))).text();
    const good = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    expect(await opened(good)).not.toBeNull();
    // A tile without its trees' list.
    const holed = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    for (const part of holed.tiles[0]!) delete part['trees'];
    expect(await opened(holed)).toBeNull();
    // A tile far past the map's edge.
    const off = JSON.parse(text) as { tiles: Record<string, unknown>[][] };
    for (const part of off.tiles[0]!) if ('key' in part) part['key'] = tileKey(5000, 0);
    expect(await opened(off)).toBeNull();
    // Cut short: not one whole file.
    expect(await openWorldFile(new Blob([text.slice(0, text.length - 3)]))).toBeNull();
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
    expect(await fresh.importWorld(meta, each([{ ...tile(0, 0), version: 1 }]), [tileKey(0, 0), tileKey(2, 2), tileKey(3, 3)])).toBe(true);
    expect((await fresh.read(tileKey(0, 0)))!.version).toBeGreaterThan(before);
    expect(await fresh.read(tileKey(2, 2))).toBeNull();
    expect((await fresh.meta())?.generator).toEqual(meta.generator);
  });

  it('refuses a file of another plan of the map: its tiles would be another city', async () => {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    await from.write(tile(0, 0));
    await from.setMeta({ version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} });
    const file = JSON.parse(await new Blob(await worldFilePieces((await from.meta())!, [tileKey(0, 0)], (key) => from.readText(key))).text()) as { plan: { plan: number } };
    expect(await opened(file)).not.toBeNull();
    file.plan.plan -= 1;
    expect(await opened(file)).toBeNull();
    delete (file as { plan?: unknown }).plan;
    expect(await opened(file)).toBeNull();
  });

  it('says a file was not opened when a tile of it could not be written: the values are not written over the world', async () => {
    const blobs = memoryStore();
    const failing: PartStore = { ...blobs, async write(put, remove) { return put.some(([k]) => k.includes(':T:')) ? false : blobs.write(put, remove); } };
    const store = new TileStore('map', storeTiles(failing), never);
    const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: {} };
    expect(await store.importWorld(meta, each([tile(0, 0)]), [tileKey(0, 0)])).toBe(false);
    expect(await store.meta()).toBeNull();
  });
});

describe('a city file, however many tiles it has', () => {
  const meta: WorldMeta = { version: 1, generator: { seed: 4, style: 'mixed', centres: 3, density: 0.5, parks: 0.05, industry: true }, unit: 1, values: { economy: { balance: 9 } } };
  /** A file of `count` tiles of the map, as the game saves it. */
  async function cityFile(count: number): Promise<{ readonly pieces: BlobPart[]; readonly keys: number[] }> {
    const from = new TileStore('map', storeTiles(memoryStore()), never);
    const keys: number[] = [];
    for (let k = 0; k < count; k++) { const t = tile((k % 10) - 5, Math.floor(k / 10) - 5); keys.push(t.key); await from.write(t); }
    await from.setMeta(meta);
    return { pieces: await worldFilePieces((await from.meta())!, keys, (key) => from.readText(key)), keys };
  }

  it('is saved a Blob a tile: no tile kept as text on the page past its own', async () => {
    for (const count of [3, 30]) {
      const { pieces } = await cityFile(count);
      // The values' head, then each tile a Blob of its own, then the end.
      expect(pieces.filter((p) => p instanceof Blob)).toHaveLength(count);
      expect(pieces.length).toBe(count + 4);
    }
  });

  it('is opened by a stream: nothing parsed longer than one tile, the same for 4 tiles or 40', async () => {
    const longest: number[] = [];
    for (const count of [4, 40]) {
      const { pieces, keys } = await cityFile(count);
      const parse = vi.spyOn(JSON, 'parse');
      const file = await openWorldFile(new Blob(pieces));
      const read = await tilesOf(file!);
      longest.push(Math.max(...parse.mock.calls.map(([text]) => String(text).length)));
      parse.mockRestore();
      expect(read.map((t) => t.key)).toEqual(keys);
    }
    // The longest text parsed: one tile's (or the values'), not the file's.
    expect(longest[1]).toBeLessThan(1.2 * longest[0]!);
  });

  it('is written into the store by one read of its marks and one removal, no tile of the map asked for alone', async () => {
    for (const count of [4, 40]) {
      const { pieces, keys } = await cityFile(count);
      const parts = memoryStore();
      const ops: string[] = [];
      const marked = withMarks(parts);
      const counted = { run: (op: TileOp) => { ops.push(op.op); return runTileOp(marked, op); } };
      const file = (await openWorldFile(new Blob(pieces)))!;
      const mapKeys = [...keys, tileKey(4, 4), tileKey(3, 4)];
      // Into a store holding none of them: each tile not marked asked for its version as it is written, at most.
      expect(await new TileStore('map', counted, never).importWorld(file.meta, (take) => file.eachTile(take), mapKeys)).toBe(true);
      expect(ops.filter((op) => op === 'version').length).toBeLessThanOrEqual(count);
      // Into a store holding them, marked: none asked, one read of the marks, one removal for the map's others.
      ops.length = 0;
      expect(await new TileStore('map', counted, never).importWorld(file.meta, (take) => file.eachTile(take), mapKeys)).toBe(true);
      expect(ops.filter((op) => op === 'marks')).toHaveLength(1);
      expect(ops.filter((op) => op === 'removeTiles')).toHaveLength(1);
      expect(ops.filter((op) => op === 'write')).toHaveLength(count);
      expect(ops.filter((op) => op === 'version')).toHaveLength(0);
    }
  });

  it('is split into its tiles wherever the chunks of the file are cut, brackets and quotes in its texts too', () => {
    const text = JSON.stringify({ version: 3, plan: { a: '[{' }, world: { v: 'x"]}\\' }, tiles: [[{ key: 1, s: '][}{"' }], [{ key: 2 }, { b: ['\\"', 2] }]] });
    for (const size of [1, 2, 3, 7, text.length]) {
      const scanner = new WorldFileScanner();
      const tiles: string[] = [];
      let head: string | null = null;
      for (let at = 0; at < text.length; at += size) {
        expect(scanner.push(text.slice(at, at + size), tiles)).toBe(true);
        if (scanner.head !== null) { head = scanner.head; scanner.head = null; }
      }
      expect(scanner.whole).toBe(true);
      expect(JSON.parse(head!)).toEqual({ version: 3, plan: { a: '[{' }, world: { v: 'x"]}\\' }, tiles: [] });
      expect(tiles.map((t) => JSON.parse(t) as unknown)).toEqual([[{ key: 1, s: '][}{"' }], [{ key: 2 }, { b: ['\\"', 2] }]]);
    }
  });
});

/** The store with marks read by a key range, as IndexedDB keeps them (`saveStore.ts` indexedDbParts). */
function withMarks(store: PartStore): PartStore {
  const marks = new Map<string, string>();
  return {
    get: (keys) => store.get(keys),
    async write(put, remove, given) { for (const [k, t] of given ?? []) marks.set(k, t); for (const k of remove) marks.delete(k); return store.write(put, remove); },
    async marks(prefix) { return [...marks].filter(([k]) => k.startsWith(prefix)); },
  };
}
