import { describe, expect, it, vi } from 'vitest';
import { PLATE_SIZE } from '@world/bounds';
import { createFlatAtlas } from '@render/flatAtlas';
import { m } from '@world/units';

/** A PLATE WHOSE PROGRAMS COULD NOT BE BUILT AHEAD IS SHOWN ALL THE SAME (`flatAtlas.ts` ensure): never left for good on its far patch, with no water and no road cut */

/** How the programs' wait fails: thrown at once, or rejected. */
const failing = vi.hoisted(() => ({ how: 'throw' as 'throw' | 'reject' }));

vi.mock('@render/uploads', async (load) => {
  const real = await load<typeof import('@render/uploads')>();
  return {
    ...real,
    // A renderer builds programs ahead here, and building them fails (`uploads.ts` compileCopy's TypeError, 10b2c447).
    compilesAhead: () => true,
    programsReady: () => {
      if (failing.how === 'throw') throw new TypeError('a program could not be built ahead');
      return Promise.reject(new TypeError('a program could not be built ahead'));
    },
  };
});
vi.mock('@render/terrain', async (load) => {
  const real = await load<typeof import('@render/terrain')>();
  const { Mesh, MeshStandardMaterial, BoxGeometry } = await import('three');
  return {
    ...real,
    farLandMaterial: () => ({ material: new MeshStandardMaterial(), dispose: () => {} }),
    createTerrainSurface: () => {
      const material = new MeshStandardMaterial();
      const meshes = [new Mesh(new BoxGeometry(), material)];
      return {
        meshes, parts: [], ground: meshes[0], vergeMaterial: material, meshMaterial: material,
        highest: () => 0, update: () => false, updatePaint: () => {}, setSun: () => {}, setWaterLook: () => {}, lookFrom: () => {},
        ecology: () => null, geologyAt: () => 'granite', gpuBytes: () => 0, textures: () => [], bakeRelief: () => {}, geologyChanges: { version: 0, rectsSince: () => [] },
        dispose: () => {},
      } as unknown as ReturnType<typeof real.createTerrainSurface>;
    },
  };
});
vi.mock('@render/farForest', async (load) => {
  const real = await load<typeof import('@render/farForest')>();
  const { Group, MeshStandardMaterial } = await import('three');
  return { ...real, createFarForest: (_s: number, grid: ConstructorParameters<typeof real.FarWoodsBook>[0], read: ConstructorParameters<typeof real.FarWoodsBook>[1]) => ({ object: new Group(), material: new MeshStandardMaterial(), book: new real.FarWoodsBook(grid, read), update: () => {}, dispose: () => {} }) };
});

describe('a plate whose programs fail to be built ahead', () => {
  for (const how of ['throw', 'reject'] as const) {
    it(`is shown all the same when the wait for them ${how === 'throw' ? 'throws' : 'is rejected'}`, async () => {
      failing.how = how;
      const atlas = createFlatAtlas(1);
      atlas.focus!(PLATE_SIZE, 0, m(300));
      await new Promise((done) => setTimeout(done, 0));
      atlas.focus!(PLATE_SIZE, 0, m(300));
      expect(atlas.parts.some((p) => p.cx === PLATE_SIZE)).toBe(true);
      atlas.dispose();
    });
  }
});
