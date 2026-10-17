import { describe, expect, it } from 'vitest';
import { type Mesh, type Object3D, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { createGardens, type GardenPlant } from '@render/gardens';
import { createSceneryKit } from '@render/scenery';
import { drainCompiles, warmPending } from '@render/uploads';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** NO MESH DRAWN BEFORE ITS PROGRAMS ARE BUILT (`uploads.ts` programsReady): the instanced layers' new meshes (`cellInstances.ts`) */
describe('a new instanced mesh', () => {
  it('is hidden until its programs, lit and in the shadow, are built, and the frames keep coming meanwhile', async () => {
    const compiled: { object: Object3D; visible: boolean }[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      // Each object as it was handed to the compiler: three builds only what is visible then.
      compileAsync: (object: Object3D) => { compiled.push({ object, visible: object.visible }); return Promise.resolve(); },
    } as unknown as WebGLRenderer;
    const scene = new Scene(), camera = new PerspectiveCamera();
    // The compiler answers from now on.
    drainCompiles(renderer, camera, scene, null);
    const gardens = createGardens(createSceneryKit());
    const plant: GardenPlant = { kind: 'tree', x: 0, y: 0, z: 0, w: m(2), d: m(2), h: m(6), yaw: 0, seed: 0.3 };
    const made = gardens.update(townChanges()([[plant]])).added;
    expect(made.length).toBeGreaterThan(0);
    for (const mesh of made) expect(mesh.visible).toBe(false);
    expect(warmPending()).toBe(true);
    drainCompiles(renderer, camera, scene, null);
    await new Promise((done) => setTimeout(done, 0));
    // Built through a visible stand-in of each (three builds ahead only what is visible: r186 `compile` walks `traverseVisible`), sharing its geometry and material.
    for (const mesh of made) expect(compiled.some((c) => c.visible && (c.object as Mesh).geometry === mesh.geometry && (c.object as Mesh).material === mesh.material)).toBe(true);
    expect(compiled.every((c) => c.visible)).toBe(true);
    expect(made.some((mesh) => mesh.visible)).toBe(true);
    expect(warmPending()).toBe(false);
  });
});
