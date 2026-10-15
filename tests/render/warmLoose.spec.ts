import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, type BufferAttribute, Mesh, MeshBasicMaterial, type Object3D, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { drainWarm, warmLooseAhead, warmPending } from '@render/uploads';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import type { SceneMaterials } from '@render/materials';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';

/** MESHES SENT TO THE GPU AHEAD, ALONE, UNTIL NONE IS LEFT (`uploads.ts` `warmLoose`) */

/** A renderer that does what three's does with a drawn mesh's buffers: uploads them (`onUploadCallback`). */
function fakeRenderer(drawn: Scene[], sizes: number[] = []): WebGLRenderer {
  return {
    render: (scene: Scene) => {
      drawn.push(scene);
      sizes.push(scene.children.length);
      scene.traverse((o: Object3D) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        for (const a of [...Object.values(g.attributes), ...(g.index ? [g.index] : [])] as BufferAttribute[]) a.onUploadCallback();
      });
    },
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
  } as unknown as WebGLRenderer;
}

const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

describe('a loose mesh sent to the GPU', () => {
  it('is drawn alone, never with the game scene, and goes back where it was, matrices untouched', async () => {
    const drawn: Scene[] = [];
    const sizes: number[] = [];
    const renderer = fakeRenderer(drawn, sizes);
    const world = new Scene();
    for (let i = 0; i < 50; i++) world.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    const group = new Group();
    world.add(group);
    const a = new Mesh(new BoxGeometry(), new MeshBasicMaterial()), b = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const c = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    group.add(a, b, c);
    b.matrixAutoUpdate = false;
    b.matrixWorld.makeTranslation(7, 8, 9);
    const before = b.matrixWorld.clone();
    drainWarm(renderer, new PerspectiveCamera(), world, null);
    drawn.length = 0;
    const sent = warmLooseAhead([b]);
    expect(warmPending()).toBe(true);
    drainWarm(renderer, new PerspectiveCamera(), world, null);
    await sent;
    expect(drawn.length).toBe(1);
    expect(drawn[0]).not.toBe(world);
    // Drawn with the mesh alone in it.
    expect(sizes).toEqual([1]);
    expect(group.children).toEqual([a, b, c]);
    expect(b.parent).toBe(group);
    expect(b.matrixWorld.equals(before)).toBe(true);
    expect(warmPending()).toBe(false);
  });

  it('keeps the frames coming while meshes wait (the renderer asks for one after each drain)', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    const drain = source.indexOf('drainWarm(renderer');
    expect(drain).toBeGreaterThan(0);
    expect(source.slice(drain, drain + 400)).toMatch(/if \(warmPending\(\)\) onAssetsReady\(\);/);
  });

  it('leaves no road block with an array on the CPU once the queue is drained', () => {
    const drawn: Scene[] = [];
    const renderer = fakeRenderer(drawn);
    const world = new Scene();
    drainWarm(renderer, new PerspectiveCamera(), world, null); // the frame loop is warming from now on
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 4, size: 'small' }));
    const net = new Network(doc);
    net.rebuild();
    const surfaces = buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground);
    world.add(surfaces.group);
    for (let guard = 0; warmPending() && guard < 100_000; guard++) drainWarm(renderer, new PerspectiveCamera(), world, null);
    expect(warmPending()).toBe(false);
    const kept: string[] = [];
    let blocks = 0;
    surfaces.group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !/^(verge|footway|kerb|asphalt|curb-ramp|median)/.test(mesh.name)) return;
      blocks++;
      const g = mesh.geometry;
      for (const [name, a] of [...Object.entries(g.attributes), ['index', g.index]] as [string, BufferAttribute | null][]) {
        if (a && a.array !== null) kept.push(`${mesh.name}.${name}`);
      }
    });
    expect(blocks).toBeGreaterThan(10);
    expect(kept).toEqual([]);
  });
});
