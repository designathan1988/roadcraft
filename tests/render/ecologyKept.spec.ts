import { describe, expect, it } from 'vitest';
import { computeEcology, type EcologyField, type EcologyInput } from '@world/ecology';
import { RELIEF_NATURAL } from '@world/terrain';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { type EcologyCache, ecologyDigest, keptEcology, keptWoods } from '@render/ecologyKept';
import { type FarWoods, type FarWoodsAsk, FarWoodsWork, farWoods } from '@render/farWoods';
import { Digest } from '@core/digest';

/** A PLATE'S ECOSYSTEM AND ITS FAR WOODS READ BACK FROM THE PLAYER'S BROWSER BEFORE THEY ARE WORKED OUT (`ecologyKept.ts`) */

/** The browser's store in memory: a copy each value (structured clone), every key written. */
function memory(): EcologyCache & { readonly kept: Map<string, unknown>; readonly puts: string[] } {
  const kept = new Map<string, unknown>();
  const puts: string[] = [];
  return { kept, puts, ready: () => Promise.resolve(true), get: (key) => Promise.resolve(kept.get(key)), put: (key, value) => { kept.set(key, structuredClone(value)); puts.push(key); return Promise.resolve(); } };
}

const SIDE = 33;
function land(wetColumn: number): EcologyInput {
  const n = SIDE * SIDE;
  const heights = new Float64Array(n), water = new Uint8Array(n);
  for (let i = 0; i < n; i++) { heights[i] = 40 * Math.sin((i % SIDE) / 5) + 9 * Math.cos(i / SIDE / 3); water[i] = i % SIDE === wetColumn ? 1 : 0; }
  return { side: SIDE, cell: 16, heights, water, sandstone: new Float32Array(n), basalt: new Float32Array(n).fill(0.3), painted: null, settings: { region: 'cerrado', seed: 9 }, centre: { x: 2048, y: -4096 } };
}
const KEYS = ['canopy', 'trees', 'emergent', 'shrub', 'palm', 'cactus', 'grass', 'dry', 'wet', 'rocky', 'region', 'waterDistance'] as const;
const same = (a: EcologyField, b: EcologyField): boolean => KEYS.every((k) => Buffer.from(a[k].buffer).equals(Buffer.from(b[k].buffer)));

describe('a plate\'s ecosystem kept', () => {
  it('is read back for the same land, worked out again and written over its plate\'s entry for another', async () => {
    const cache = memory();
    const first = await keptEcology(land(10), cache, 'ecology:t:');
    expect(same(first, computeEcology(land(10)))).toBe(true);
    expect(cache.puts).toEqual(['ecology:t:2048,-4096']);
    // A reload: what is kept comes back, nothing worked out (a value no working-out makes, under the same land's digest).
    const marked = { ...first, side: -1 };
    cache.kept.set('ecology:t:2048,-4096', { digest: ecologyDigest(land(10)), value: marked });
    expect((await keptEcology(land(10), cache, 'ecology:t:')).side).toBe(-1);
    // The river moved: worked out again, the plate's one entry written over.
    const moved = await keptEcology(land(20), cache, 'ecology:t:');
    expect(same(moved, computeEcology(land(20)))).toBe(true);
    expect(cache.kept.size).toBe(1);
    expect(ecologyDigest(land(20))).not.toBe(ecologyDigest(land(10)));
  });

  it('keeps nothing with no fingerprint of its code (tests, a build without it)', async () => {
    const cache = memory();
    await keptEcology(land(10), cache, null);
    expect(cache.puts).toEqual([]);
  });
});

describe('a far plate\'s woods kept', () => {
  const grid = { side: Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: 32 };
  const ask: FarWoodsAsk = { relief: RELIEF_NATURAL, nature: { region: 'atlantic', seed: 5 }, cx: 0, cy: 2048, grid };
  it('is read back for the same ask, worked out for another', async () => {
    const cache = memory();
    const work = new FarWoodsWork();
    const first = await keptWoods(ask, work, cache, 'farWoods:t:');
    expect(Array.from(first.x)).toEqual(Array.from(farWoods(ask).x));
    const marked: FarWoods = { ...first, count: -1 };
    cache.kept.set('farWoods:t:0,2048', { digest: new Digest().addPlain(ask).value(), value: marked });
    expect((await keptWoods(ask, work, cache, 'farWoods:t:')).count).toBe(-1);
    const other = await keptWoods({ ...ask, nature: { region: 'atlantic', seed: 6 } }, work, cache, 'farWoods:t:');
    expect(other.count).toBe(farWoods({ ...ask, nature: { region: 'atlantic', seed: 6 } }).count);
    expect(cache.kept.size).toBe(1);
  });
});
