import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Layers, Line, LineBasicMaterial, Mesh, MeshStandardMaterial, type Object3D,
  PerspectiveCamera, Points, PointsMaterial, Scene, type WebGLRenderer,
} from 'three';
import { drainCompiles, drainWarm, gateUntilBuilt, warmLooseAhead, warmPending } from '@render/uploads';

/** THE ONE DOOR INTO THE DRAWN SCENE (`uploads.ts` gateUntilBuilt): nothing is drawn with a program not built */

const drawnBy = new Layers();
const drawn = (o: Object3D): boolean => o.layers.test(drawnBy);
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function compiler(): { renderer: WebGLRenderer; compiled: Object3D[]; drain(): void } {
  const compiled: Object3D[] = [];
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    render: () => {},
    autoClear: true,
    compileAsync: (object: Object3D) => { object.traverse((o) => compiled.push(o)); return Promise.resolve(); },
  } as unknown as WebGLRenderer;
  const scene = new Scene(), camera = new PerspectiveCamera();
  drainCompiles(renderer, camera, scene, null);
  return { renderer, compiled, drain: () => drainCompiles(renderer, camera, scene, null) };
}

describe('the door into the drawn scene', () => {
  it('holds every kind of thing that comes in off the drawn layers until its programs, lit and in the shadow, are built', async () => {
    const { compiled, drain } = compiler();
    const material = new MeshStandardMaterial();
    const plain = new Mesh(new BoxGeometry(), material);
    plain.castShadow = true;
    const instanced = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 4);
    const group = new Group();
    group.add(instanced);
    const line = new Line(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3)), new LineBasicMaterial());
    const points = new Points(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)), new PointsMaterial());
    for (const root of [plain, group, line, points]) gateUntilBuilt(root);
    const things = [plain, instanced, line, points];
    for (const thing of things) expect(drawn(thing)).toBe(false);
    expect(warmPending()).toBe(true);
    drain();
    await tick();
    for (const thing of things) {
      expect(compiled).toContain(thing);
      expect(drawn(thing)).toBe(true);
    }
    // Its shadow's program too: a stand-in on a depth material.
    expect(compiled.some((o) => ((o as Mesh).material as { isMeshDepthMaterial?: boolean }).isMeshDepthMaterial)).toBe(true);
    expect(warmPending()).toBe(false);
    // Another mesh of a variant built: in at once.
    const twin = new Mesh(new BoxGeometry(), material);
    twin.castShadow = true;
    gateUntilBuilt(twin);
    expect(drawn(twin)).toBe(true);
  });

  it('lets a mesh warmed before it comes in through at once', async () => {
    const { renderer, drain } = compiler();
    drainWarm(renderer);
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const sent = warmLooseAhead([mesh])!;
    drainWarm(renderer);
    drain();
    await sent;
    gateUntilBuilt(mesh);
    expect(drawn(mesh)).toBe(true);
  });

  it('is what the renderer passes everything that comes into the scene through', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    expect(source).toMatch(/const onChildAdded = [^\n]*gateUntilBuilt\(event\.child\)/);
  });

  it('always settles: without the parallel compile (built at once), a mesh let go meanwhile, a compile that never answers (given up after its frames)', async () => {
    const scene = new Scene(), camera = new PerspectiveCamera();
    // No KHR_parallel_shader_compile: three's compile, at once, off the draw.
    const built: Object3D[] = [];
    const plain = {
      getRenderTarget: () => null, setRenderTarget: () => {}, render: () => {}, autoClear: true,
      extensions: { has: () => false },
      compile: (object: Object3D) => { built.push(object); },
      compileAsync: () => new Promise(() => {}),
    } as unknown as WebGLRenderer;
    drainCompiles(plain, camera, scene, null);
    const a = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    gateUntilBuilt(a);
    expect(drawn(a)).toBe(false);
    drainCompiles(plain, camera, scene, null);
    await tick();
    expect(built).toContain(a);
    expect(drawn(a)).toBe(true);
    // A compile that never answers: the door opens after its frames, the mesh drawn as before.
    const stuck = {
      getRenderTarget: () => null, setRenderTarget: () => {}, render: () => {}, autoClear: true,
      compileAsync: () => new Promise(() => {}),
    } as unknown as WebGLRenderer;
    const b = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    gateUntilBuilt(b);
    for (let frame = 0; frame < 40; frame++) drainCompiles(stuck, camera, scene, null);
    await tick();
    expect(drawn(b)).toBe(true);
    // A loose mesh let go before it went up: what waits for it is told.
    drainWarm(stuck);
    const c = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    let told = false;
    void warmLooseAhead([c])!.then(() => { told = true; });
    const { cancelWarm } = await import('@render/uploads');
    cancelWarm([c]);
    await tick();
    expect(told).toBe(true);
    // One let go while its programs are built: settled all the same.
    const d = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    let settled = false;
    void warmLooseAhead([d])!.then(() => { settled = true; });
    drainWarm(stuck);
    cancelWarm([d]);
    for (let frame = 0; frame < 40; frame++) drainCompiles(stuck, camera, scene, null);
    await tick();
    expect(settled).toBe(true);
    expect(warmPending()).toBe(false);
  });
});
