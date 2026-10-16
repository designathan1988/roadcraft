import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { TileRecords } from '@world/doc';
import { tileIdBase, tileKey, tileOfKey } from '@world/tiles';
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
    // One tile east: the west column (i = -1) is kept in the ring, not active; the east column (i = 2) is active and not loaded yet.
    streamer.focus(1024 + 10, 10);
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
