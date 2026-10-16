import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { TileRecords } from '@world/doc';
import { tileIdBase, tileKey, tileOfKey } from '@world/tiles';
import { WorldStreamer } from '@/worldStreamer';

/** THE ACTIVE REGION'S STREAMER (`worldStreamer.ts`): the region's tiles first, then the ring it loads next, then the far levels' tiles one at a time. */

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
  it('makes nothing ahead before the region is in, then the ring several at once, nothing past it', async () => {
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
    // Past the ring: nothing is made ahead (AHEAD_RADIUS is the ring: the generator's plan draws the city beyond it).
    expect(store.ensures.filter((key) => ring(key) > 2)).toHaveLength(0);
    expect(store.ensures.some((key) => ring(key) <= 1)).toBe(false);
  });
});
