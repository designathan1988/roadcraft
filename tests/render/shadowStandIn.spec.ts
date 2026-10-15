import { describe, expect, it } from 'vitest';
import { BackSide, BoxGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Texture, type Camera, type MeshDepthMaterial, type Object3D, type Scene, type WebGLRenderer } from 'three';

import { compileAhead, drainCompiles, shadowStandIn } from '@render/uploads';

/**
 * THE SHADOWS COMPILED AHEAD (`uploads.ts` shadowStandIn): stand-ins of
 * different variants compiled in one batch are each compiled with their own
 * depth variant - the side, the map and the alpha test the shadow pass will
 * draw them with. On one shared depth material set when each stand-in was
 * made, every one was compiled as the last one made, and the others' shadow
 * programs were linked in the first shadow pass that drew them.
 */
describe('the shadow stand-ins compiled ahead', () => {
  it('are each compiled with their own depth variant, in one batch', async () => {
    const seen: string[] = [];
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      compileAsync: (object: Object3D) => {
        object.traverse((o) => {
          const depth = (o as Mesh).material as MeshDepthMaterial | undefined;
          if (depth?.isMeshDepthMaterial) seen.push(JSON.stringify([depth.side, depth.alphaTest, !!depth.map]));
        });
        return Promise.resolve();
      },
    } as unknown as WebGLRenderer;
    const camera = {} as Camera, scene = {} as Scene;
    // The renderer answers from now on (`compileAhead` waits for it).
    drainCompiles(renderer, camera, scene, null);
    const box = new BoxGeometry();
    const bench = new Mesh(box, new MeshStandardMaterial());
    const plate = new Mesh(box, new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.5, side: DoubleSide }));
    bench.castShadow = plate.castShadow = true;
    const shadows = new Group();
    for (const mesh of [bench, plate]) shadows.add(shadowStandIn(mesh)!);
    const done = compileAhead(shadows, true);
    drainCompiles(renderer, camera, scene, null);
    await done;
    expect(seen).toContain(JSON.stringify([BackSide, 0, false]));
    expect(seen).toContain(JSON.stringify([DoubleSide, 0.5, true]));
  });
});
