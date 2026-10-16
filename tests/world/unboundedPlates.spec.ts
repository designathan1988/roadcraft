import { describe, expect, it, vi } from 'vitest';
import {
  PLATE_SIZE, WORLD_HALF, clampToWorld, insideWorld, plateIJ, plateKey, plateOf, plateOfKey, plateRegion, platesAround, platesOver, regionAt,
} from '@world/bounds';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import type { FarWoodsBook } from '@render/farForest';
import { createFlatAtlas } from '@render/flatAtlas';

/** THE WORLD HAS NO SIZE: an unbounded grid of plates (`world/bounds.ts`), made on demand near the view (`render/flatAtlas.ts`) */

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
        ecology: () => null, geologyAt: () => 'granite',
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

  it('makes plates round the camera, one a frame, on the map only, and lets them go when it leaves', () => {
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
    // The camera back home: the corner's plates let go.
    for (let frame = 0; frame < 12; frame++) atlas.focus!(m(100), m(-50), m(300));
    for (const k of seen.live) expect(near(k, 0, 0, PLATE_SIZE * 2)).toBe(true);
    expect(seen.book!.plates.size).toBe(25);
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
