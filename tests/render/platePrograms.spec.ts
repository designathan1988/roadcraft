import { describe, expect, it, vi } from 'vitest';
import { type Mesh, type Object3D, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { PLATE_SIZE } from '@world/bounds';
import { createFlatAtlas } from '@render/flatAtlas';
import { drainCompiles } from '@render/uploads';
import { m } from '@world/units';

/** NO PLATE OF THE GROUND DRAWN BEFORE ITS PROGRAMS ARE BUILT (`flatAtlas.ts`, `programsFirst.ts`): the far patch stands in meanwhile */

/** Each plate's meshes, by centre. */
const made = vi.hoisted(() => new Map<string, Mesh[]>());

// A plate's surface stands in for the real one: its meshes, their material its own.
vi.mock('@render/terrain', async (load) => {
  const real = await load<typeof import('@render/terrain')>();
  const { Mesh, MeshStandardMaterial, BoxGeometry } = await import('three');
  return {
    ...real,
    farLandMaterial: () => ({ material: new MeshStandardMaterial(), dispose: () => {} }),
    createTerrainSurface: (_anisotropy: number, origin: { readonly x: number; readonly y: number }) => {
      const material = new MeshStandardMaterial();
      const meshes = [new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), material)];
      made.set(`${origin.x},${origin.y}`, meshes);
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
  const { Group } = await import('three');
  return { ...real, createFarForest: (_s: number, grid: ConstructorParameters<typeof real.FarWoodsBook>[0], read: ConstructorParameters<typeof real.FarWoodsBook>[1]) => ({ object: new Group(), book: new real.FarWoodsBook(grid, read), update: () => {}, dispose: () => {} }) };
});

describe('a plate of the ground made while the game runs', () => {
  it('is shown only once its programs are built, through visible stand-ins of its meshes', async () => {
    const compiled: { object: Object3D; visible: boolean }[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      // Each object as it was handed to the compiler: three builds only what is visible then.
      compileAsync: (object: Object3D) => { compiled.push({ object, visible: object.visible }); return Promise.resolve(); },
    } as unknown as WebGLRenderer;
    const scene = new Scene(), camera = new PerspectiveCamera();
    const atlas = createFlatAtlas(1);
    // The compiler answers from now on (the opening's own programs built with the scene).
    drainCompiles(renderer, camera, scene, null);
    const centre = `${PLATE_SIZE},0`;
    atlas.focus!(PLATE_SIZE, 0, m(300));
    expect(made.has(centre)).toBe(true);
    // Made, not shown: its programs not built yet.
    expect(atlas.parts.some((p) => p.cx === PLATE_SIZE)).toBe(false);
    drainCompiles(renderer, camera, scene, null);
    await new Promise((done) => setTimeout(done, 0));
    for (const mesh of made.get(centre)!) expect(compiled.some((c) => c.visible && (c.object as Mesh).geometry === mesh.geometry && (c.object as Mesh).material === mesh.material)).toBe(true);
    // Built: shown at the next look.
    atlas.focus!(PLATE_SIZE, 0, m(300));
    expect(atlas.parts.some((p) => p.cx === PLATE_SIZE)).toBe(true);
    atlas.dispose();
  });
});
