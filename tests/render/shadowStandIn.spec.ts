import { describe, expect, it } from 'vitest';
import {
  BackSide, BoxGeometry, DoubleSide, FrontSide, Group, InstancedMesh, Mesh, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, Texture,
  type Camera, type Object3D, type Scene, type WebGLRenderer,
} from 'three';

import { compileAhead, drainCompiles, shadowStandIn, shadowStandIns } from '@render/uploads';

/** A renderer that records each depth material's variant as it is compiled. */
function recorder(seen: string[]): WebGLRenderer {
  return {
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
}
const camera = {} as Camera, scene = {} as Scene;

/** THE SHADOWS COMPILED AHEAD (`uploads.ts` shadowStandIn) */
describe('the shadow stand-ins compiled ahead', () => {
  it('are each compiled with their own depth variant, in one batch', async () => {
    const seen: string[] = [];
    const renderer = recorder(seen);
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

  it('compile a caster\'s own depth material as the shadow pass sets it, from the material it is drawn with', async () => {
    const seen: string[] = [];
    const renderer = recorder(seen);
    drainCompiles(renderer, camera, scene, null);
    // A skinned body's depth material, made front-sided: three draws a front-sided body's shadow with its back faces.
    const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: FrontSide });
    const body = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.35 }), 1);
    body.castShadow = true;
    body.customDepthMaterial = depth;
    const standIn = shadowStandIn(body) as Mesh;
    expect(standIn.material).toBe(depth);
    const done = compileAhead(standIn, true);
    drainCompiles(renderer, camera, scene, null);
    await done;
    expect(seen).toContain(JSON.stringify([BackSide, 0.35, true]));
    expect(seen).not.toContain(JSON.stringify([FrontSide, 0, false]));
  });

  it('give a body of several materials one stand-in for each variant its groups cast', () => {
    const skin = new MeshStandardMaterial();
    const hair = new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.5, side: DoubleSide });
    const body = new Mesh(new BoxGeometry(), [skin, hair, skin.clone()]);
    body.castShadow = true;
    const standIn = shadowStandIn(body)!;
    const meshes: Mesh[] = [];
    standIn.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    // The second skin casts as the first: the same program.
    expect(meshes).toHaveLength(2);
  });

  it('compile the casters of a whole scene once for each program they cast with', () => {
    const root = new Group();
    const box = new BoxGeometry();
    const material = new MeshStandardMaterial();
    for (let i = 0; i < 50; i++) {
      const mesh = new Mesh(box, material);
      mesh.castShadow = true;
      root.add(mesh);
    }
    const cut = new Mesh(box, new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.5 }));
    cut.castShadow = true;
    root.add(cut, new Mesh(box, material));
    let standIns = 0;
    shadowStandIns(root).traverse((o) => { if ((o as Mesh).isMesh) standIns++; });
    expect(standIns).toBe(2);
  });
});
