import { describe, expect, it } from 'vitest';
import { MAP_REGIONS, PLATE_SIZE } from '@world/bounds';
import { RELIEF_NATURAL } from '@world/terrain';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { farWoods, type FarWoods, type FarWoodsAsk } from '@render/farWoods';
import { FarWoodsBook, type FarWoodsReader } from '@render/farForest';

/** THE WOODS OF THE WHOLE MAP (`farWoods.ts`, `farForest.ts`) */

const GRID = { side: Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: 32 };
const NATURE = { region: 'cerrado' as const, seed: 4242 };

describe('a far plate\'s woods', () => {
  const corner = MAP_REGIONS[0]!;
  const woods = farWoods({ relief: RELIEF_NATURAL, nature: NATURE, cx: corner.cx, cy: corner.cy, grid: GRID });

  it('grows trees on a plate far from the middle, within the plate, on the ground', () => {
    expect(woods.count).toBeGreaterThan(500);
    for (let i = 0; i < woods.count; i += 97) {
      expect(Math.abs(woods.x[i]! - corner.cx)).toBeLessThan(PLATE_SIZE / 2);
      expect(Math.abs(woods.y[i]! - corner.cy)).toBeLessThan(PLATE_SIZE / 2);
      expect(Number.isFinite(woods.z[i]!)).toBe(true);
      expect(woods.size[i]!).toBeGreaterThan(4);
      expect(woods.pick[i]!).toBeLessThan(1);
    }
  });

  it('costs the same on any plate of the map: the plate\'s lattice, not the map', () => {
    const middle = farWoods({ relief: RELIEF_NATURAL, nature: NATURE, cx: 0, cy: 0, grid: GRID });
    expect(middle.work).toBe(woods.work);
    const cells = Math.floor((2 * TERRAIN_HALF) / 5);
    expect(woods.work).toBe(cells * cells);
  });

  it('is the same trees every time it is worked out (no Math.random)', () => {
    const again = farWoods({ relief: RELIEF_NATURAL, nature: NATURE, cx: corner.cx, cy: corner.cy, grid: GRID });
    expect(again.count).toBe(woods.count);
    expect(Array.from(again.x.subarray(0, 50))).toEqual(Array.from(woods.x.subarray(0, 50)));
  });
});

/** A worker stand-in: answers at once with a few trees per plate, counting the asks. */
function stubReader(): { read: FarWoodsReader; asked: number[] } {
  const asked: number[] = [];
  const one = (ask: FarWoodsAsk): FarWoods => {
    const n = 3;
    const f = (v: number): Float32Array => new Float32Array(n).fill(v);
    return { count: n, x: f(ask.cx), y: f(ask.cy), z: f(0), size: f(10), yaw: f(0), seed: f(0.1), pick: f(0.5), planned: 20_000, work: 1 };
  };
  return { asked, read: (key, ask, done) => { asked.push(key); done(one(ask)); } };
}

describe('the far woods\' bookkeeping', () => {
  it('asks each plate once per land and ecosystem, however many frames ask again', () => {
    const { read, asked } = stubReader();
    const book = new FarWoodsBook(MAP_REGIONS, GRID, read);
    for (let frame = 0; frame < 120; frame++) {
      book.sync(RELIEF_NATURAL, NATURE, 0, 0);
      book.step(frame / 60);
    }
    expect(asked.length).toBe(MAP_REGIONS.length);
    expect(book.stats.asks).toBe(MAP_REGIONS.length);
    book.sync(RELIEF_NATURAL, { region: 'amazon', seed: 4242 }, 0, 0);
    expect(asked.length).toBe(2 * MAP_REGIONS.length);
  });

  it('has trees on every plate not drawn in full, none drawn under a plate in full once its own grow', () => {
    const { read } = stubReader();
    const book = new FarWoodsBook(MAP_REGIONS, GRID, read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    expect(book.stats.ready).toBe(MAP_REGIONS.length);
    expect(book.stats.drawn).toBe(MAP_REGIONS.length);
    const home = 12;
    // In full but its ecosystem not yet in: its far trees stay (no hole).
    book.setFull(home, true, false, 0);
    book.step(5);
    expect(book.plates[home]!.fade).toBe(1);
    // Its own trees can grow: the far ones dissolve over a moment, not at once.
    book.setFull(home, true, true, 10);
    book.step(10.1);
    expect(book.plates[home]!.fade).toBe(1);
    book.step(11.0);
    expect(book.plates[home]!.fade).toBeGreaterThan(0);
    expect(book.plates[home]!.fade).toBeLessThan(1);
    book.step(12);
    expect(book.plates[home]!.fade).toBe(0);
    expect(book.stats.drawn).toBe(MAP_REGIONS.length - 1);
    // Let go: back at once.
    book.setFull(home, false, false, 13);
    book.step(13);
    expect(book.plates[home]!.fade).toBe(1);
  });

  it('stands as thick as the quality tier lets the near woods stand, none at none', () => {
    const { read } = stubReader();
    const book = new FarWoodsBook(MAP_REGIONS, GRID, read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    const full = book.scale;
    book.setVegetation(1_300);
    expect(book.scale).toBeLessThan(full);
    book.setVegetation(0);
    expect(book.scale).toBe(0);
    book.setVegetation(2_600);
    expect(book.scale).toBe(full);
  });

  it('asks nothing on a map with no ecosystem', () => {
    const { read, asked } = stubReader();
    const book = new FarWoodsBook(MAP_REGIONS, GRID, read);
    book.sync(RELIEF_NATURAL, null, 0, 0);
    expect(asked.length).toBe(0);
    expect(book.stats.drawn).toBe(0);
  });
});
