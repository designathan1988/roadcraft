import { describe, expect, it } from 'vitest';
import { type MadeTile, TileStore } from '@editor/tileStore';
import { tileKey } from '@world/tiles';

/** A world reopened asks no worker for the parking bays its tiles were stored with (`TileStore.addBays`) */

describe('the tile store reopening a world', () => {
  it('asks no bays of a tile the maker said holds them, and asks each other tile once', async () => {
    const asked: string[] = [];
    const maker = (i: number, j: number, _after: number, _records: boolean, ifMissing: boolean, baysOnly = false): Promise<MadeTile> => {
      asked.push(`${baysOnly ? 'bays' : ifMissing ? 'ensure' : 'make'} ${i},${j}`);
      return Promise.resolve({ version: 3, existed: true, ...(i === 0 && !baysOnly ? { bays: true } : {}) });
    };
    const store = new TileStore('map', { run: () => Promise.resolve(null) }, () => Promise.reject(new Error('not made here')), maker);
    const baked = tileKey(0, 0), bare = tileKey(1, 0);
    await store.ensure(baked);
    await store.ensure(bare);
    await store.addBays(baked);
    await store.addBays(bare);
    await store.addBays(bare);
    expect(asked).toEqual(['ensure 0,0', 'ensure 1,0', 'bays 1,0']);
  });
});
