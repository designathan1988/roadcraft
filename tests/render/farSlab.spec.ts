import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import { createFlatAtlas } from '@render/flatAtlas';

/** THE MAP'S SLAB MADE AGAIN ONLY WHEN THE RELIEF MOVES (TER-15, 2026-10-19): it reads the relief alone, never the far nodes the view asks. */
const seen = vi.hoisted(() => ({ slabs: 0 }));

// A plate's surface stands in for the real one (as `tests/world/unboundedPlates.spec.ts`); the slabs made counted.
vi.mock('@render/terrain', async (load) => {
  const real = await load<typeof import('@render/terrain')>();
  const { Mesh, MeshStandardMaterial } = await import('three');
  return {
    ...real,
    slabGeometry: (...args: Parameters<typeof real.slabGeometry>) => { seen.slabs++; return real.slabGeometry(...args); },
    farLandMaterial: () => ({ material: new MeshStandardMaterial(), dispose: () => {} }),
    createTerrainSurface: () => {
      const material = new MeshStandardMaterial();
      return {
        meshes: [new Mesh()], parts: [], ground: new Mesh(), vergeMaterial: material, meshMaterial: material,
        highest: () => 0, update: () => false, updatePaint: () => {}, setSun: () => {}, setWaterLook: () => {}, lookFrom: () => {},
        ecology: () => null, geologyAt: () => 'granite', gpuBytes: () => 0, textures: () => [], bakeRelief: () => {}, geologyChanges: { version: 0, rectsSince: () => [] },
        dispose: () => {},
      } as unknown as ReturnType<typeof real.createTerrainSurface>;
    },
  };
});
vi.mock('@render/farForest', async (load) => {
  const real = await load<typeof import('@render/farForest')>();
  const { Group } = await import('three');
  return {
    ...real,
    createFarForest: (_slots: number, grid: ConstructorParameters<typeof real.FarWoodsBook>[0], read: ConstructorParameters<typeof real.FarWoodsBook>[1]) =>
      ({ object: new Group(), book: new real.FarWoodsBook(grid, read), update: () => {}, dispose: () => {} }),
  };
});

describe('the map\'s slab', () => {
  it('is made once for a relief, however the view walks the far ground', () => {
    const atlas = createFlatAtlas(1);
    atlas.update(new RoadDoc(), false);
    const made = seen.slabs;
    expect(made).toBe(1);
    // The view past the map's corners: the far nodes it asks change there (over a 10 km map they are all plates), the relief never.
    for (const [x, y] of [[-1.2, -1.2], [1.2, 1.2], [-1.2, 1.2], [1.2, -1.2]] as const) for (let frame = 0; frame < 2; frame++) atlas.focus!(x * MAP_HALF, y * MAP_HALF, m(12_000));
    expect(seen.slabs).toBe(made);
    atlas.dispose();
  });
});
