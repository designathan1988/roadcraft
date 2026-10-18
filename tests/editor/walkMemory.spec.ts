import { describe, expect, it } from 'vitest';
import type { PartStore } from '@editor/saveStore';
import { TileStore, storeTiles } from '@editor/tileStore';
import { History } from '@editor/history';
import { RoadDoc } from '@world/doc';
import type { RecordPart, TileRecords } from '@world/doc';
import type { PlantedTree } from '@world/trees';
import { OWNER, TILE, tileIdBase, tileKey, tileOfRecord } from '@world/tiles';
import { WorldStreamer } from '@/worldStreamer';

/** WHAT THE PAGE KEEPS ALIVE OF THE WORLD WALKED THROUGH (the document of the region, the streamer, the page's tile store, the undo): the same after 2 tiles walked as after 20 - DO NOT keep what grows with the path (the cage filled walking 4 districts, 2026-10-17) */

/** A store in memory with marks, as IndexedDB keeps them. */
function memoryStore(): PartStore {
  const values = new Map<string, Blob | string>();
  return {
    async get(keys) { return keys.map((k) => { const v = values.get(k); return v instanceof Blob ? v : null; }); },
    async write(put, remove, marks) { for (const [k, b] of put) values.set(k, b); for (const [k, t] of marks ?? []) values.set(k, t); for (const k of remove) values.delete(k); return true; },
    async marks(prefix) { return [...values].filter((e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'); },
  };
}

/** Every tile alike: 120 trees spread over it. */
function tileOf(key: number, i: number, j: number): TileRecords {
  const base = tileIdBase(key);
  const trees = Array.from({ length: 120 }, (_, k) => ({ x: i * TILE + 20 + (k % 12) * 80, y: j * TILE + 20 + Math.floor(k / 12) * 90, height: 10, yaw: 0, seed: 0.5 }));
  return {
    key, version: 0, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees, elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

const turns = async (n: number): Promise<void> => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };

/** Objects and typed bytes reachable from `roots` (what a heap keeps for them): own properties, Map and Set entries, array items. */
function reachable(roots: readonly object[], stop: ReadonlySet<object> = new Set()): { objects: number; bytes: number } {
  const seen = new Set<object>(stop);
  const stack: unknown[] = [...roots];
  let bytes = 0;
  while (stack.length) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (ArrayBuffer.isView(value)) { bytes += value.byteLength; continue; }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) { bytes += value.byteLength; continue; }
    if (value instanceof Map) { for (const [k, v] of value) stack.push(k, v); }
    else if (value instanceof Set) { for (const v of value) stack.push(v); }
    for (const name of Object.getOwnPropertyNames(value)) {
      let v: unknown;
      try { v = (value as Record<string, unknown>)[name]; } catch { continue; }
      stack.push(v);
    }
  }
  return { objects: seen.size - stop.size, bytes };
}

/** The region walked over `path` (tile by tile), a tree planted in each tile it stands on, every write let through; what the page keeps after. */
async function walk(path: readonly (readonly [number, number])[], driveBy = false): Promise<{ objects: number; bytes: number; loaded: number; bakes: number }> {
  const doc = new RoadDoc();
  const history = new History();
  const store = new TileStore('map', storeTiles(memoryStore()), (i, j) => Promise.resolve(tileOf(tileKey(i, j), i, j)));
  const streamer = new WorldStreamer(doc, store, {
    // As the game wires them (`main.ts` openStreamedWorld): the bake taken as the tile is put in; the undo of what went with a tile let go.
    loaded: (key) => { store.takeBake(key); },
    letGo: (key, removedAt, gone) => { history.letGoTile((r) => gone.get(r.part as RecordPart)?.has(r.id) === true || tileOfRecord(r.part, r.id, r.value) === key, (item) => itemInTile(item, key), removedAt); },
  });
  let frame = 0;
  /** The camera held at (x, y) until the region is in and nothing more comes or goes: one tile put in or let go a frame. */
  const stand = async (x: number, y: number): Promise<void> => {
    for (let k = 0, still = 0; k < 400 && still < 5; k++) {
      const before = [...doc.loadedTiles].sort().join();
      streamer.focus(x, y); streamer.apply(frame++); await turns(1);
      still = streamer.settled && before === [...doc.loadedTiles].sort().join() ? still + 1 : 0;
    }
  };
  for (const [i, j] of path) {
    const x = (i + 0.5) * TILE, y = (j + 0.5) * TILE;
    // Driven by: a frame on the tile, its region's tiles asked and come after the camera went on.
    if (driveBy) { streamer.focus(x, y); streamer.apply(frame++); await turns(1); continue; }
    await stand(x, y);
    history.begin(doc);
    doc.plantTrees([{ x: x + 3, y: y + 3, height: 10, yaw: 0, seed: 0.3 } satisfies PlantedTree]);
    history.end(doc);
    streamer.apply(frame++);
    expect(await streamer.flush()).toBe(true);
  }
  // Both walks end alike: a far corner, then the other, so the region there (3 x 3) is all the document holds.
  await stand(2.5 * TILE, 2.5 * TILE);
  await stand(-2.5 * TILE, -2.5 * TILE);
  expect(await streamer.flush()).toBe(true);
  // The document's diary stops the count: its cap by the slowest reader still alive is the simulacao's item (5d3ed80b, 1089c543 on merge/coordinator), its growth with the path measured there.
  return { ...reachable([doc, streamer, store, history], new Set([doc.changes])), loaded: doc.loadedTiles.size, bakes: (store as unknown as { bakes: Map<number, unknown> }).bakes.size };
}

/** A place of an item of a list in tile `key` (`main.ts` itemInTile). */
function itemInTile(item: unknown, key: number): boolean {
  const p = item as { x?: number; y?: number } | null;
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && OWNER.at(p as { x: number; y: number }) === key;
}

/** A snake over the map's inside (its region and ring whole on the map), `n` tiles long. */
function snake(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = -3; j <= 2 && out.length < n; j++) {
    for (let k = 0; k < 6 && out.length < n; k++) out.push([j % 2 === 0 ? -3 + k : 2 - k, j]);
  }
  return out;
}

describe('the page walking through the world', () => {
  it('keeps the same after 20 tiles walked as after 2', async () => {
    const short = await walk(snake(2));
    const long = await walk(snake(20));
    console.log('walked 2:', short, ' walked 20:', long);
    expect(long.loaded).toBe(9);
    expect(short.loaded).toBe(9);
    // Within a few objects: the same region, the same undo's groups; nothing a tile walked past leaves behind.
    expect(long.objects).toBeLessThan(short.objects * 1.05);
    expect(long.bytes).toBeLessThan(short.bytes * 1.05 + 4096);
  }, 10_000);


  it("lets go what came for a tile the camera drove past: its network bake is not kept", async () => {
    const after = await walk(snake(20), true);
    expect(after.loaded).toBe(9);
    expect(after.bakes).toBe(0);
  }, 10_000);
});
