import { InstancedBufferAttribute, InstancedMesh, Mesh } from 'three';
import { compilesAhead, programsReady } from './uploads';

/** A MESH SHOWN ONLY ONCE ITS PROGRAMS ARE BUILT: the ground's plates, its far patches and slab, the far woods (`flatAtlas.ts`, `farForest.ts`) */

/** Whether a mesh waits for its programs here (a renderer builds them ahead; none in tests: nothing waits). */
export const programsWaited = compilesAhead;

/**
 * The programs of `meshes`, lit and in the shadow, built ahead (`uploads.ts` programsReady) through visible stand-ins sharing their
 * geometry and material: three builds ahead only what is visible (r186 `WebGLRenderer.compile` walks `traverseVisible`), and the meshes
 * themselves wait hidden.
 */
/** `casts`: whether they throw a shadow when drawn (a mesh cast by size has none until it has instances, `shadowCasters.ts`); their own flag without it. */
export function programsOf(meshes: readonly Mesh[], casts?: boolean): Promise<unknown> {
  return Promise.all(meshes.map((mesh) => {
    // The same program variant: instanced (and with a colour per instance) as the mesh is.
    const instanced = mesh as InstancedMesh;
    let standIn: Mesh;
    if (instanced.isInstancedMesh) {
      const one = new InstancedMesh(mesh.geometry, mesh.material, 1);
      if (instanced.instanceColor) one.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
      standIn = one;
    } else standIn = new Mesh(mesh.geometry, mesh.material);
    standIn.castShadow = casts ?? mesh.castShadow;
    standIn.receiveShadow = mesh.receiveShadow;
    if (mesh.customDepthMaterial) standIn.customDepthMaterial = mesh.customDepthMaterial;
    return programsReady(standIn);
  }));
}
