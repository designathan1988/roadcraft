import { describe, expect, it, vi } from 'vitest';
import {
  PLATE_SIZE, WORLD_HALF, clampToWorld, insideWorld, plateIJ, plateKey, plateOf, plateOfKey, plateRegion, platesAround, platesOver, regionAt,
} from '@world/bounds';
import { RoadDoc } from '@world/doc';
import { TILE_UNLOADED } from '@world/changes';
import { m } from '@world/units';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import type { FarWoodsBook } from '@render/farForest';
import { createFlatAtlas } from '@render/flatAtlas';
import { gpuLedger } from '@render/gpuLedger';

/** THE WORLD HAS NO SIZE: an unbounded grid of plates (`world/bounds.ts`), made on demand near the view (`render/flatAtlas.ts`) */

/** What each plate stands in for on the GPU. */
const PLATE_BYTES = 10 * 2 ** 20;
/** The plates the atlas made and has not let go, by centre, and the far woods' book (the far ring's plates). */
const seen = vi.hoisted(() => ({ live: new Set<string>(), made: 0, book: null as FarWoodsBook | null }));

// A plate's surface stands in for the real one (its textures and shaders are not what is tested): only its making and letting go are counted.
vi.mock('@render/terrain', async (load) => {
  const real = await load<typeof import('@render/terrain')>();
  const { Mesh, MeshStandardMaterial } = await import('three');
  return {
    ...real,
    // The far patches' material, made without a plate.
    farLandMaterial: () => ({ material: new MeshStandardMaterial(), dispose: () => {} }),
    createTerrainSurface: (_anisotropy: number, origin: { readonly x: number; readonly y: number }, key: number) => {
      const id = `${origin.x},${origin.y}`;
      // Every plate made is counted: the far ground makes none of its own.
      seen.made++;
      if (key >= 0) seen.live.add(id);
      const material = new MeshStandardMaterial();
      let gone = false;
      return {
        meshes: [new Mesh()], parts: [], ground: new Mesh(), vergeMaterial: material, meshMaterial: material,
        highest: () => 0, update: () => false, updatePaint: () => {}, setSun: () => {}, setWaterLook: () => {}, lookFrom: () => {},
        ecology: () => null, geologyAt: () => 'granite', gpuBytes: () => PLATE_BYTES, textures: () => [], bakeRelief: () => {}, geologyChanges: { version: 0, rectsSince: () => [] },
        dispose: () => { if (!gone && key >= 0) seen.live.delete(id); gone = true; },
      } as unknown as ReturnType<typeof real.createTerrainSurface>;
    },
  };
});
// The far woods: their book kept to read the far ring; no pictures taken.
vi.mock('@render/farForest', async (load) => {
  const real = await load<typeof import('@render/farForest')>();
  const { Group } = await import('three');
  return {
    ...real,
    createFarForest: (_slots: number, grid: ConstructorParameters<typeof real.FarWoodsBook>[0], read: ConstructorParameters<typeof real.FarWoodsBook>[1]) => {
      const book = new real.FarWoodsBook(grid, read);
      seen.book = book;
      return { object: new Group(), book, update: () => {}, dispose: () => {} };
    },
  };
});

describe('the plates of an unbounded world', () => {
  it('names the plate of any point, far past the old 10 km map, with no clamp', () => {
    const x = m(1_523_456.5), y = m(-23_000_100);
    const key = plateOf(x, y);
    const r = regionAt(x, y);
    expect(r.key).toBe(key);
    expect(Math.abs(x - r.cx)).toBeLessThanOrEqual(PLATE_SIZE / 2);
    expect(Math.abs(y - r.cy)).toBeLessThanOrEqual(PLATE_SIZE / 2);
    expect(r.cx % PLATE_SIZE).toBe(0);
    expect(plateOfKey(key)).toEqual(plateIJ(x, y));
    expect(plateRegion(key)).toEqual(r);
    // Two far points a plate apart are two plates (a map's clamp made them one).
    expect(plateOf(x + PLATE_SIZE, y)).not.toBe(key);
    expect(plateOf(m(40_000), 0)).not.toBe(plateOf(m(42_048), 0));
  });

  it('centres plate (pi, pj) on (pi, pj) x PLATE_SIZE, a point on an edge the plate whose low edge it is', () => {
    expect(regionAt(0, 0)).toMatchObject({ cx: 0, cy: 0, half: PLATE_SIZE / 2 });
    expect(regionAt(PLATE_SIZE / 2, 0).cx).toBe(PLATE_SIZE);
    expect(regionAt(-PLATE_SIZE / 2, 0).cx).toBe(0);
    expect(regionAt(PLATE_SIZE * 3 - 1, -PLATE_SIZE * 7).cx).toBe(PLATE_SIZE * 3);
    // Every key its own plate, and back.
    for (const [pi, pj] of [[0, 0], [-1, 0], [0, -1], [5000, -16_000], [-16_000, 16_000]] as const) {
      expect(plateOfKey(plateKey(pi, pj))).toEqual({ pi, pj });
    }
  });

  it('lists the plates a rectangle reaches and those round a plate, never a world of them', () => {
    expect(platesOver([m(-10), m(-10), m(10), m(10)])).toEqual([plateKey(0, 0)]);
    const over = platesOver([PLATE_SIZE * 99.6, PLATE_SIZE * -3.2, PLATE_SIZE * 101.2, PLATE_SIZE * -2.9]);
    // Columns 100 and 101 (99.6 lies on plate 100, past its low edge at 99.5), row -3.
    expect(over).toEqual([plateKey(100, -3), plateKey(101, -3)]);
    const ring = platesAround(700, -40, 3);
    expect(ring).toHaveLength(49);
    expect(new Set(ring).size).toBe(49);
    expect(ring[0]).toBe(plateKey(700, -40));
    for (const k of ring) {
      const { pi, pj } = plateOfKey(k);
      expect(Math.max(Math.abs(pi - 700), Math.abs(pj + 40))).toBeLessThanOrEqual(3);
    }
  });

  it('holds nothing but to the world\'s reach, far past any city', () => {
    expect(WORLD_HALF).toBeGreaterThan(m(30_000_000));
    expect(insideWorld({ x: m(250_000), y: m(-900_000) })).toBe(true);
    expect(clampToWorld({ x: m(250_000), y: m(-900_000) })).toEqual({ x: m(250_000), y: m(-900_000) });
    expect(clampToWorld({ x: 1e12, y: 5 })).toEqual({ x: WORLD_HALF, y: 5 });
    expect(() => plateKey(1 << 20, 0)).toThrow();
    // A road far from the old map's edge stays where it was drawn.
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(48_000), y: m(-91_000) });
    expect(a.x).toBe(m(48_000));
    expect(a.y).toBe(m(-91_000));
  });
});

describe('the ground of the map', () => {
  const near = (key: string, x: number, y: number, reach: number): boolean => {
    const [cx, cy] = key.split(',').map(Number) as [number, number];
    return Math.abs(cx - x) <= reach && Math.abs(cy - y) <= reach;
  };
  /** A plate's centre on the map (`wholeMap.ts` MAP_HALF: the map's edge on the plates' edges). */
  const onMap = (cx: number, cy: number): boolean => Math.abs(cx) < MAP_HALF && Math.abs(cy) < MAP_HALF;

  it('makes plates round the camera, on the map only, keeps them hidden while the GPU has room, and lets them go when it has none', () => {
    seen.live.clear();
    seen.made = 0;
    const atlas = createFlatAtlas(1);
    // The first plate, at the origin (its materials lent to the verges), and nothing else.
    expect([...seen.live]).toEqual(['0,0']);
    // At the map's north-east corner: the plates round it on the map, none past its edge.
    const x = MAP_HALF - m(300), y = MAP_HALF - m(200);
    for (let frame = 0; frame < 12; frame++) atlas.focus!(x, y, m(300));
    const under = `${PLATE_SIZE * 2},${PLATE_SIZE * 2}`;
    expect(seen.live.has(under)).toBe(true);
    const far = [...seen.live].filter((k) => k !== '0,0');
    expect(far.length).toBeGreaterThan(0);
    expect(far.length).toBeLessThanOrEqual(9);
    for (const k of far) {
      expect(near(k, x, y, PLATE_SIZE * 2)).toBe(true);
      const [cx, cy] = k.split(',').map(Number) as [number, number];
      expect(onMap(cx, cy), `plate ${k} past the map's edge`).toBe(true);
    }
    // The far ground is the map's 5 x 5 plates, wherever the camera.
    const ring = [...seen.book!.plates.values()];
    expect(ring).toHaveLength(25);
    for (const p of ring) expect(onMap(p.cx, p.cy)).toBe(true);
    // A read far away makes no plate.
    const made = seen.made;
    atlas.heightAt(m(9_000_000), m(-4_000_000));
    expect(seen.made).toBe(made);
    // The camera back home with room on the GPU: the corner's plates kept hidden, and none made again when it goes back.
    const corner = new Set(far);
    for (let frame = 0; frame < 12; frame++) atlas.focus!(m(100), m(-50), m(300));
    for (const k of corner) expect(seen.live.has(k), `plate ${k} let go with room for it`).toBe(true);
    const before = seen.made;
    for (let frame = 0; frame < 12; frame++) atlas.focus!(x, y, m(300));
    expect(seen.made).toBe(before);
    // No room past the plates drawn: the hidden ones let go when the view moves on.
    const cap = gpuLedger.cap;
    gpuLedger.cap = gpuLedger.bytes();
    for (let frame = 0; frame < 12; frame++) atlas.focus!(m(100), m(-50), m(300));
    gpuLedger.cap = cap;
    for (const k of seen.live) expect(near(k, 0, 0, PLATE_SIZE), `plate ${k} kept with no room`).toBe(true);
    expect(seen.book!.plates.size).toBe(25);
    atlas.dispose();
  });

  it('keeps as many plates made after a long walk as after a short one: what the view holds, never the way it came', () => {
    /** The plates made and not let go after the view walked `tiles` tiles along a snake over the map, a street's view at each step. */
    const after = (tiles: number): number => {
      seen.live.clear();
      const atlas = createFlatAtlas(1);
      const step = m(256);
      let x = -MAP_HALF + m(600), y = -MAP_HALF + m(600), dx = step;
      for (let walked = 0; walked < (tiles * m(1024)) / step; walked++) {
        x += dx;
        // Back the other way a row up at the map's edge.
        if (Math.abs(x) > MAP_HALF - m(600)) { x -= dx; dx = -dx; y += m(2048); }
        for (let frame = 0; frame < 3; frame++) atlas.focus!(x, y, m(300));
      }
      // The same view at the end of every walk.
      for (let frame = 0; frame < 12; frame++) atlas.focus!(m(100), m(-50), m(300));
      const live = seen.live.size;
      atlas.dispose();
      return live;
    };
    const short = after(4), long = after(20), longer = after(40);
    // The plates drawn round the view, the ones kept for a zoom out and back (`CACHED_MOST`), and the first one: not the plates walked over.
    expect(long).toBeLessThanOrEqual(1 + 9 + 9);
    expect(longer).toBe(long);
    expect(short).toBeLessThanOrEqual(long);
  });

  it('holds as many plates as its tier: fewer for a weak machine in a district view and after a walk, the strong tier as before', () => {
    /** The plates made and not let go in a district's view at the map's middle (3 x 3 plates within its reach), then after a walk and in the map's view. */
    const held = (plates?: readonly [number, number]): { district: number; map: number } => {
      seen.live.clear();
      const atlas = createFlatAtlas(1);
      if (plates) atlas.setPlates!(plates[0], plates[1]);
      for (let frame = 0; frame < 12; frame++) atlas.focus!(0, 0, m(800));
      // The first plate, at the origin, is one of the 3 x 3.
      const district = seen.live.size;
      for (let x = -MAP_HALF + m(600); x < MAP_HALF - m(600); x += m(512)) for (let frame = 0; frame < 3; frame++) atlas.focus!(x, m(2048), m(800));
      // The map's view: no plate in full, the ones kept made.
      for (let frame = 0; frame < 12; frame++) atlas.focus!(0, 0, m(12_000));
      // The first plate is never let go, nor counted among those kept.
      const map = seen.live.size - 1;
      atlas.dispose();
      return { district, map };
    };
    const strong = held(), weak = held([4, 2]);
    // The strong tier as before: the 3 x 3 drawn, nine kept for a zoom out and back.
    expect(strong).toEqual({ district: 9, map: 9 });
    expect(held([9, 9])).toEqual(strong);
    // A weak machine's: four drawn, two kept (each plate ~10 MB of arrays on the page and ~7-17 MB on the GPU).
    expect(weak.district).toBe(4);
    expect(weak.map).toBeLessThanOrEqual(2);
  });

  it('makes every plate the view wants whose corners are in in the frame it is wanted, not one a frame', () => {
    seen.live.clear();
    seen.made = 0;
    const atlas = createFlatAtlas(1);
    // No workers here: every corner read on the page, every plate wanted made at once.
    // Between four plates: each centre within the view's reach.
    atlas.focus!(PLATE_SIZE / 2, PLATE_SIZE / 2, m(300));
    const wanted = [...seen.live].filter((k) => k !== '0,0');
    expect(wanted.length).toBe(3);
    // A second frame makes none more.
    const made = seen.made;
    atlas.focus!(PLATE_SIZE / 2, PLATE_SIZE / 2, m(300));
    expect(seen.made).toBe(made);
    atlas.dispose();
  });

  it('asks again only the plates a tile let go reaches, never the whole document', () => {
    seen.live.clear();
    const doc = new RoadDoc();
    const atlas = createFlatAtlas(1);
    atlas.updatePaint(doc);
    // Every whole read of the document counted (`readWholeContent` walks the buildings).
    let wholes = 0;
    const all = doc.buildings.all.bind(doc.buildings);
    doc.buildings.all = () => { wholes++; return all(); };
    // Trees put on plate (2, 0): it holds content, drawn in full.
    const square = [PLATE_SIZE * 1.6, m(10), PLATE_SIZE * 1.9, m(300)] as const;
    doc.changes.record('trees', [square]);
    atlas.updatePaint(doc);
    expect(atlas.parts.some((p) => p.cx === PLATE_SIZE * 2)).toBe(true);
    // Its tile let go: that plate holds nothing more, and nothing else was read.
    doc.changes.causeNext(TILE_UNLOADED);
    doc.changes.record('trees', [square]);
    atlas.updatePaint(doc);
    expect(wholes).toBe(0);
    expect(atlas.parts.some((p) => p.cx === PLATE_SIZE * 2)).toBe(false);
    atlas.dispose();
  });

  it('makes none for the whole map at once: zoomed far out, the far patches alone', () => {
    seen.live.clear();
    seen.made = 0;
    const atlas = createFlatAtlas(1);
    for (let frame = 0; frame < 30; frame++) atlas.focus!(0, 0, m(5_000));
    // Nothing in full but the first plate; the far ground the map's 25 plates.
    expect([...seen.live]).toEqual(['0,0']);
    expect(seen.made).toBe(1);
    expect(seen.book!.plates.size).toBe(25);
    atlas.dispose();
  });
});
