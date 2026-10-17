import { describe, expect, it } from 'vitest';
import { type Object3D, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { createGardens, type GardenPlant } from '@render/gardens';
import { createSceneryKit } from '@render/scenery';
import { drainCompiles, warmPending } from '@render/uploads';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** NO MESH DRAWN BEFORE ITS PROGRAMS ARE BUILT (`uploads.ts` programsReady): the instanced layers' new meshes (`cellInstances.ts`) */
describe('a new instanced mesh', () => {
  it('is hidden until its programs, lit and in the shadow, are built, and the frames keep coming meanwhile', async () => {
    const compiled: Object3D[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      compileAsync: (object: Object3D) => { compiled.push(object); return Promise.resolve(); },
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
    for (const mesh of made) expect(compiled).toContain(mesh);
    expect(made.some((mesh) => mesh.visible)).toBe(true);
    expect(warmPending()).toBe(false);
  });
});
