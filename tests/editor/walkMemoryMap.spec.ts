import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartStore } from '@editor/saveStore';
import type { TileRecords } from '@world/doc';

/** WHAT THE PAGE KEEPS ALIVE OF THE WORLD (the region's document, the streamer, the page's tile store, the undo) ON A MAP OF 10 KM AND ONE OF 20, THE SAME TILES WALKED AND THE WHOLE MAP MADE AHEAD: the same - DO NOT keep on the page what grows with the map (the page near 0.9 GB at 20 km, 2026-10-18) */

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

/** A store in memory with marks, as IndexedDB keeps them (its blobs are not the page's: held in a closure, never reached from the roots). */
function memoryStore(): PartStore {
  const values = new Map<string, Blob | string>();
  return {
    async get(keys) { return keys.map((k) => { const v = values.get(k); return v instanceof Blob ? v : null; }); },
    async write(put, remove, marks) { for (const [k, b] of put) values.set(k, b); for (const [k, t] of marks ?? []) values.set(k, t); for (const k of remove) values.delete(k); return true; },
    async marks(prefix) { return [...values].filter((e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'); },
  };
}

const turns = async (n: number): Promise<void> => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };

/** Objects and entries (of maps, sets, arrays) reachable from `roots`, by the root's field they were first reached from; typed bytes apart. */
function reachable(roots: Readonly<Record<string, object>>, stop: ReadonlySet<object>): { objects: number; bytes: number; byField: Record<string, number> } {
  const seen = new Set<object>(stop);
  const byField: Record<string, number> = {};
  let bytes = 0, slots = 0;
  for (const [name, root] of Object.entries(roots)) {
    for (const field of Object.getOwnPropertyNames(root)) {
      const before = seen.size + slots;
      const stack: unknown[] = [(root as Record<string, unknown>)[field]];
      while (stack.length) {
        const value = stack.pop();
        if (typeof value !== 'object' || value === null || seen.has(value)) continue;
        seen.add(value);
        if (ArrayBuffer.isView(value)) { bytes += value.byteLength; continue; }
        if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) { bytes += value.byteLength; continue; }
        // Entries count too: a set of tile keys is numbers, no object each.
        if (value instanceof Map) { slots += value.size; for (const [k, v] of value) stack.push(k, v); }
        else if (value instanceof Set) { slots += value.size; for (const v of value) stack.push(v); }
        else if (Array.isArray(value)) slots += value.length;
        for (const name of Object.getOwnPropertyNames(value)) {
          let v: unknown;
          try { v = (value as Record<string, unknown>)[name]; } catch { continue; }
          stack.push(v);
        }
      }
      if (seen.size + slots > before) byField[`${name}.${field}`] = seen.size + slots - before;
    }
  }
  return { objects: seen.size - stop.size + slots, bytes, byField };
}

/** On a map of `mapTiles` tiles each way: the region walked over 20 tiles (a tree planted in each), the whole map made ahead, the camera back in a corner; what the page keeps. */
async function walkOn(mapTiles: number): Promise<{ objects: number; bytes: number; byField: Record<string, number>; made: number; total: number }> {
  vi.stubGlobal('__MAP_TILES__', mapTiles);
  vi.resetModules();
  const { RoadDoc } = await import('@world/doc');
  const { History } = await import('@editor/history');
  const { TileStore, storeTiles } = await import('@editor/tileStore');
  const { WorldStreamer } = await import('@/worldStreamer');
  const { OWNER, TILE, tileIdBase, tileKey, tileOfRecord } = await import('@world/tiles');
  const { MAP_TILES } = await import('@world/cityGen/wholeMap');
  expect(MAP_TILES).toBe(mapTiles);
  const tileOf = (i: number, j: number): TileRecords => {
    const key = tileKey(i, j), base = tileIdBase(key);
    const trees = Array.from({ length: 60 }, (_, k) => ({ x: i * TILE + 20 + (k % 10) * 90, y: j * TILE + 20 + Math.floor(k / 10) * 150, height: 10, yaw: 0, seed: 0.5 }));
    return {
      key, version: 0, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
      landscape: [], barriers: [], paint: [], trees, elements: [],
      next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
    };
  };
  const doc = new RoadDoc();
  const history = new History();
  const store = new TileStore('map', storeTiles(memoryStore()), (i, j) => Promise.resolve(tileOf(i, j)));
  const itemIn = (item: unknown, key: number): boolean => {
    const p = item as { x?: number; y?: number } | null;
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && OWNER.at(p as { x: number; y: number }) === key;
  };
  // As the game wires them (`main.ts` openStreamedWorld).
  const streamer = new WorldStreamer(doc, store, {
    loaded: (key) => { store.takeBake(key); },
    letGo: (key, removedAt, gone) => { history.letGoTile((r) => gone.get(r.part as never)?.has(r.id) === true || tileOfRecord(r.part, r.id, r.value) === key, (item) => itemIn(item, key), removedAt); },
  }, 8);
  let frame = 0;
  const stand = async (x: number, y: number): Promise<void> => {
    for (let k = 0, still = 0; k < 400 && still < 5; k++) {
      const before = [...doc.loadedTiles].sort().join();
      streamer.focus(x, y); streamer.apply(frame++); await turns(1);
      still = streamer.settled && before === [...doc.loadedTiles].sort().join() ? still + 1 : 0;
    }
  };
  // The same 20 tiles on both maps (inside the smaller one), a tree planted in each.
  for (let n = 0; n < 20; n++) {
    const j = -3 + Math.floor(n / 6), k = n % 6, i = j % 2 === 0 ? -3 + k : 2 - k;
    const x = (i + 0.5) * TILE, y = (j + 0.5) * TILE;
    await stand(x, y);
    history.begin(doc);
    doc.plantTrees([{ x: x + 3, y: y + 3, height: 10, yaw: 0, seed: 0.3 }]);
    history.end(doc);
    streamer.apply(frame++);
    expect(await streamer.flush()).toBe(true);
  }
  // The rest of the map made ahead, as the game does after the curtain.
  for (let k = 0; k < 6000 && streamer.mapMade < streamer.mapTotal; k++) { streamer.focus(-2.5 * TILE, -2.5 * TILE); streamer.apply(frame++); await turns(1); }
  await stand(2.5 * TILE, 2.5 * TILE);
  await stand(-2.5 * TILE, -2.5 * TILE);
  expect(await streamer.flush()).toBe(true);
  // The document's diary is the simulacao's to cap (5d3ed80b, 1089c543): out of this count.
  const live = reachable({ doc, store, streamer, history }, new Set([doc.changes]));
  return { ...live, made: streamer.mapMade, total: streamer.mapTotal };
}

describe('the page on a map of 10 km and one of 20', () => {
  it('keeps the same, the same 20 tiles walked and the whole map made', async () => {
    const small = await walkOn(10);
    const large = await walkOn(20);
    expect(small.made).toBe(100);
    expect(large.made).toBe(400);
    const grew = Object.keys(large.byField).filter((k) => (large.byField[k] ?? 0) > (small.byField[k] ?? 0) + 2).map((k) => `${k}: ${small.byField[k] ?? 0} -> ${large.byField[k]}`);
    console.log('10 km:', small.objects, 'objects,', small.bytes, 'bytes; 20 km:', large.objects, 'objects,', large.bytes, 'bytes', grew.join(' | '));
    // What may grow, and why: the store's floor of each tile's version (`TileStore.versions`, a number a tile the store holds: a tile made again after a file is opened goes past what was baked of it, the far levels' bakes keyed by version), and the bays' square round the camera, cut by the smaller map's edge there.
    expect(grew.filter((k) => !k.startsWith('store.versions:') && !k.startsWith('streamer.baysOrder:'))).toEqual([]);
    expect(large.byField['store.versions']! - (small.byField['store.versions'] ?? 0)).toBeLessThanOrEqual(large.total - small.total);
    // The tiles known and the order they are made in: bytes outside the cage, one and eight a tile.
    expect(large.bytes - small.bytes).toBeLessThanOrEqual(9 * (large.total - small.total));
  }, 10_000);
});
