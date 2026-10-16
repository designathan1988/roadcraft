import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, Group, Mesh, MeshDepthMaterial, MeshStandardMaterial, Scene,
  type Camera, type Material, type Object3D, type WebGLRenderer,
} from 'three';

import { drainCompiles } from '@render/uploads';
import { PROGRAM_FAMILIES, createShaderCatalogue } from '@render/shaderCatalogue';

/** THE PROGRAMS COMPILED AT LOAD (`shaderCatalogue.ts`) */
describe('the shader catalogue', () => {
  /** A renderer that records the materials it is asked to compile. */
  const compiled = new Set<Material>();
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    compileAsync: (object: Object3D) => {
      object.traverse((o) => { if ((o as Mesh).isMesh) compiled.add((o as Mesh).material as Material); });
      return Promise.resolve();
    },
  } as unknown as WebGLRenderer;
  const camera = {} as Camera;

  it('compiles every family, lit and in the shadow, before it is ready', async () => {
    const scene = new Scene();
    drainCompiles(renderer, camera, scene, null);
    const box = new BoxGeometry();
    const ground = new Mesh(box, new MeshStandardMaterial());
    ground.castShadow = true;
    const hidden = new Mesh(box, new MeshStandardMaterial());
    hidden.visible = false;
    scene.add(ground, hidden);
    const personLit = new MeshStandardMaterial(), personDepth = new MeshDepthMaterial();
    const catalogue = createShaderCatalogue(() => {
      const lit = new Group(), shadow = new Group();
      lit.add(new Mesh(box, personLit));
      shadow.add(new Mesh(box, personDepth));
      return { lit, shadow };
    });
    let ready = false;
    void catalogue.ready.then(() => { ready = true; });
    catalogue.compile(scene);
    drainCompiles(renderer, camera, scene, null);
    await catalogue.ready;
    expect(ready).toBe(true);
    // The world's hidden things too, and its casters on a depth material; the people's every stand-in.
    expect(compiled.has(hidden.material)).toBe(true);
    expect([...compiled].some((m) => (m as MeshDepthMaterial).isMeshDepthMaterial && m !== personDepth)).toBe(true);
    expect(compiled.has(personLit) && compiled.has(personDepth)).toBe(true);
    const counts = catalogue.counts();
    for (const family of PROGRAM_FAMILIES) {
      expect(counts[family], family).not.toBeNull();
      expect(counts[family]!.compiled, family).toBe(true);
      expect(counts[family]!.lit, family).toBeGreaterThan(0);
      expect(counts[family]!.shadow, family).toBeGreaterThan(0);
    }
  });

  it('waits again for a map being opened, its people compiled once', async () => {
    const scene = new Scene();
    drainCompiles(renderer, camera, scene, null);
    let builds = 0;
    const catalogue = createShaderCatalogue(() => {
      builds++;
      return { lit: new Group(), shadow: new Group() };
    });
    catalogue.compile(scene);
    drainCompiles(renderer, camera, scene, null);
    const first = catalogue.ready;
    await first;
    catalogue.begin();
    expect(catalogue.ready).not.toBe(first);
    catalogue.compile(scene);
    drainCompiles(renderer, camera, scene, null);
    await catalogue.ready;
    expect(builds).toBe(1);
  });

  it('is never awaited for ever on a family that cannot be built', async () => {
    const scene = new Scene();
    drainCompiles(renderer, camera, scene, null);
    const catalogue = createShaderCatalogue(() => { throw new Error('no body'); });
    const said = console.error;
    console.error = () => {};
    try {
      catalogue.compile(scene);
    } finally {
      console.error = said;
    }
    drainCompiles(renderer, camera, scene, null);
    await catalogue.ready;
    expect(catalogue.counts().people).toBeNull();
  });
});
