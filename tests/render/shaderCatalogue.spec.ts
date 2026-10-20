import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, DirectionalLight, Group, Mesh, MeshDepthMaterial, MeshStandardMaterial, PointLight, Scene,
  type Camera, type Material, type Object3D, type WebGLRenderer,
} from 'three';

import { compileAhead, drainCompiles } from '@render/uploads';
import { PROGRAM_FAMILIES, createShaderCatalogue, litStandIns } from '@render/shaderCatalogue';

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
  /** Drained a frame at a time until `until` settles: the curtain's light set is asked only once the families are built. */
  const drainUntil = async (target: WebGLRenderer, scene: Scene, until: Promise<void>): Promise<void> => {
    let settled = false;
    void until.then(() => { settled = true; });
    for (let frame = 0; frame < 50 && !settled; frame++) {
      drainCompiles(target, camera, scene, null);
      await new Promise((done) => setTimeout(done, 0));
    }
    expect(settled).toBe(true);
  };

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

  it('compiles the light variant the town opens under before it is ready, the others once the curtain lifts, one stand-in a lit program, with that variant\'s lights', async () => {
    const scene = new Scene();
    const sets: number[] = [];
    const lighted = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      compileAsync: (object: Object3D, _camera: Camera, target: Scene) => {
        let lights = 0;
        target.traverseVisible((o) => { if ((o as PointLight).isLight) lights++; });
        if (object !== scene && (object as Group).isGroup && object.children.length) sets.push(lights);
        return Promise.resolve();
      },
    } as unknown as WebGLRenderer;
    drainCompiles(lighted, camera, scene, null);
    const box = new BoxGeometry();
    const shared = new MeshStandardMaterial();
    for (let i = 0; i < 5; i++) scene.add(new Mesh(box, shared));
    const lamp = new PointLight(0xffffff, 0);
    lamp.visible = false;
    scene.add(lamp, new DirectionalLight());
    const sun = scene.children.at(-1)!;
    const catalogue = createShaderCatalogue(() => ({ lit: new Group(), shadow: new Group() }), () => [[sun], [sun, lamp]]);
    catalogue.compile(scene);
    await drainUntil(lighted, scene, catalogue.ready);
    // Only the first set (the lights the town opens under) holds the curtain.
    expect(sets).toEqual([1]);
    catalogue.afterReveal();
    for (let frame = 0; frame < 6; frame++) {
      await new Promise((done) => setTimeout(done, 0));
      drainCompiles(lighted, camera, scene, null);
    }
    expect(sets.sort()).toEqual([1, 2]);
    // Five meshes of one material and geometry: one stand-in.
    expect(litStandIns([scene]).children.length).toBe(1);
  });

  it('asks the light variants the curtain did not wait for only once it lifts, one set at a time: the programs of the view never wait behind them', async () => {
    const scene = new Scene();
    const asked: string[] = [];
    let view: () => void = () => {};
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      compileAsync: (object: Object3D) => {
        if (object.name === 'view') { asked.push('view'); return new Promise<void>((done) => { view = done; }); }
        if ((object as Group).isGroup && object.children.length) { asked.push('variant'); return new Promise<void>((done) => setTimeout(done, 0)); }
        return Promise.resolve();
      },
    } as unknown as WebGLRenderer;
    drainCompiles(renderer, camera, scene, null);
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new DirectionalLight());
    const sun = scene.children.at(-1)!;
    const catalogue = createShaderCatalogue(() => ({ lit: new Group(), shadow: new Group() }), () => [[sun], [sun], [sun]]);
    catalogue.compile(scene);
    await drainUntil(renderer, scene, catalogue.ready);
    // The set the town opens under, before the curtain; the others wait for it to lift.
    expect(asked).toEqual(['variant']);
    // A mesh of the view comes in and is compiling: no variant asked meanwhile, nor ahead of it once the curtain lifts.
    const mesh = Object.assign(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), { name: 'view' });
    void compileAhead(mesh);
    for (let frame = 0; frame < 4; frame++) { await new Promise((done) => setTimeout(done, 0)); drainCompiles(renderer, camera, scene, null); }
    expect(asked).toEqual(['variant', 'view']);
    catalogue.afterReveal();
    drainCompiles(renderer, camera, scene, null);
    drainCompiles(renderer, camera, scene, null);
    // One set at a time: the next is asked once the last is built.
    expect(asked).toEqual(['variant', 'view', 'variant']);
    for (let frame = 0; frame < 12; frame++) { await new Promise((done) => setTimeout(done, 0)); drainCompiles(renderer, camera, scene, null); }
    expect(asked).toEqual(['variant', 'view', 'variant', 'variant']);
    view();
  });
});

describe('the lights in the key of every program', () => {
  it('keeps the fill in the scene day and night (one program a material for it, not two), and makes a variant only of the point lights switched on or off', () => {
    const environment = readFileSync('src/render/environment.ts', 'utf8');
    // Its intensity follows the day; it never leaves the scene (r186 counts every visible light in the key).
    expect(environment).not.toMatch(/fill\.visible\s*=/);
    const renderer = readFileSync('src/render/renderer.ts', 'utf8');
    const variants = /const lightVariants = [^]*?\n {2}\};/.exec(renderer)?.[0] ?? '';
    // Two sets, the points off and on, the fill in both; the one the town opens under first.
    expect(variants).toMatch(/const off = \[\.\.\.base, \.\.\.\(fill \? \[fill\] : \[\]\)\], on = \[\.\.\.base, \.\.\.points, \.\.\.\(fill \? \[fill\] : \[\]\)\];/);
    expect(variants).toMatch(/return lit \? \[on, off\] : \[off, on\];/);
    expect(variants).not.toMatch(/filled/);
  });
});
