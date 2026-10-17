import { describe, expect, it } from 'vitest';
import { PLATE_SIZE, plateKey, plateRegion, platesAround } from '@world/bounds';
import { RELIEF_NATURAL } from '@world/terrain';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { farWoods, type FarWoods, type FarWoodsAsk } from '@render/farWoods';
import { FarWoodsBook, type FarWoodsReader } from '@render/farForest';

/** THE WOODS OF THE FAR PLATES (`farWoods.ts`, `farForest.ts`) */

const GRID = { side: Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: 32 };
const NATURE = { region: 'cerrado' as const, seed: 4242 };

describe('a far plate\'s woods', () => {
  const corner = plateRegion(plateKey(-2, -2));
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

/** A ring of 5 x 5 far plates round the origin, each in its slot, as the atlas adds them (`flatAtlas.ts` the far ring). */
const RING = platesAround(0, 0, 2).map(plateRegion);
function bookOf(read: FarWoodsReader): FarWoodsBook {
  const book = new FarWoodsBook(GRID, read);
  RING.forEach((r, slot) => book.add(r.key, slot, r.cx, r.cy));
  return book;
}

describe('the far woods\' bookkeeping', () => {
  it('follows the ring: a plate gone is let go, a plate come in asked once, an answer for a plate gone dropped', () => {
    const answers: (() => void)[] = [];
    const asked: number[] = [];
    const read: FarWoodsReader = (key, ask, done) => {
      asked.push(key);
      answers.push(() => done({ count: 1, x: Float32Array.of(ask.cx), y: Float32Array.of(ask.cy), z: Float32Array.of(0), size: Float32Array.of(10),
        yaw: Float32Array.of(0), seed: Float32Array.of(0.1), pick: Float32Array.of(0.5), planned: 20_000, work: 1 }));
    };
    const book = bookOf(read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    expect(asked).toHaveLength(RING.length);
    const gone = RING[RING.length - 1]!;
    book.drop(gone.key);
    expect(book.gone).toEqual([gone.key]);
    // A plate far out, in the slot let go: asked at once, the land being known.
    const far = plateRegion(plateKey(500, -300));
    book.add(far.key, RING.length - 1, far.cx, far.cy);
    expect(asked).toHaveLength(RING.length + 1);
    expect(asked[asked.length - 1]).toBe(far.key);
    for (const answer of answers) answer();
    expect(book.plates.has(gone.key)).toBe(false);
    expect(book.arrived).not.toContain(gone.key);
    expect(book.arrived).toContain(far.key);
    expect(book.stats.ready).toBe(RING.length);
  });

  it('asks each plate once per land and ecosystem, however many frames ask again', () => {
    const { read, asked } = stubReader();
    const book = bookOf(read);
    for (let frame = 0; frame < 120; frame++) {
      book.sync(RELIEF_NATURAL, NATURE, 0, 0);
      book.step(frame / 60);
    }
    expect(asked.length).toBe(RING.length);
    expect(book.stats.asks).toBe(RING.length);
    book.sync(RELIEF_NATURAL, { region: 'amazon', seed: 4242 }, 0, 0);
    expect(asked.length).toBe(2 * RING.length);
  });

  it('has trees on every plate not drawn in full, none drawn under a plate in full once its own grow', () => {
    const { read } = stubReader();
    const book = bookOf(read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    expect(book.stats.ready).toBe(RING.length);
    expect(book.stats.drawn).toBe(RING.length);
    const home = RING[0]!.key;
    // In full but its ecosystem not yet in: its far trees stay (no hole).
    book.setFull(home, true, false, 0);
    book.step(5);
    expect(book.plates.get(home)!.fade).toBe(1);
    // Its own trees can grow: the far ones dissolve over a moment, not at once.
    book.setFull(home, true, true, 10);
    book.step(10.1);
    expect(book.plates.get(home)!.fade).toBe(1);
    book.step(11.0);
    expect(book.plates.get(home)!.fade).toBeGreaterThan(0);
    expect(book.plates.get(home)!.fade).toBeLessThan(1);
    book.step(12);
    expect(book.plates.get(home)!.fade).toBe(0);
    expect(book.stats.drawn).toBe(RING.length - 1);
    // Let go: back at once.
    book.setFull(home, false, false, 13);
    book.step(13);
    expect(book.plates.get(home)!.fade).toBe(1);
  });

  it('stands as thick as the quality tier lets the near woods stand, none at none', () => {
    const { read } = stubReader();
    const book = bookOf(read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    const home = RING[0]!.key;
    const scale = (): number => book.plates.get(home)!.scale;
    const full = scale();
    book.setVegetation(1_300);
    expect(scale()).toBeLessThan(full);
    // Its instances written again at the new scale.
    expect(book.arrived).toContain(home);
    book.setVegetation(0);
    expect(scale()).toBe(0);
    book.setVegetation(2_600);
    expect(scale()).toBe(full);
  });

  it('keeps each plate scale as its woods came: a plate of another density coming in changes none of the others', () => {
    const answers = new Map<number, () => void>();
    const read: FarWoodsReader = (key, ask, done) => {
      // A plate twice as wooded as the others: an average over the plates would move theirs.
      const planned = key === RING[3]!.key ? 90_000 : 20_000;
      answers.set(key, () => done({ count: 1, x: Float32Array.of(ask.cx), y: Float32Array.of(ask.cy), z: Float32Array.of(0), size: Float32Array.of(10),
        yaw: Float32Array.of(0), seed: Float32Array.of(0.1), pick: Float32Array.of(0.5), planned, work: 1 }));
    };
    const book = bookOf(read);
    book.sync(RELIEF_NATURAL, NATURE, 0, 0);
    for (const [key, answer] of answers) if (key !== RING[3]!.key) answer();
    const before = RING.filter((r) => r.key !== RING[3]!.key).map((r) => book.plates.get(r.key)!.scale);
    answers.get(RING[3]!.key)!();
    expect(RING.filter((r) => r.key !== RING[3]!.key).map((r) => book.plates.get(r.key)!.scale)).toEqual(before);
    // Its own scale its own density's: a thicker plate thinned more.
    expect(book.plates.get(RING[3]!.key)!.scale).toBeLessThan(before[0]!);
  });

  it('asks nothing on a map with no ecosystem', () => {
    const { read, asked } = stubReader();
    const book = bookOf(read);
    book.sync(RELIEF_NATURAL, null, 0, 0);
    expect(asked.length).toBe(0);
    expect(book.stats.drawn).toBe(0);
  });
});
