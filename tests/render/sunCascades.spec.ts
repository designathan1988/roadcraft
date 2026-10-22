import { describe, expect, it } from 'vitest';
import { Box3, DirectionalLight, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, BoxGeometry, Object3D, type OrthographicCamera, PerspectiveCamera, ShaderChunk, Vector3, type WebGLRenderer } from 'three';

import { cascadedSunChunks, createSunCascades, SUN_CASCADES } from '@render/sunCascades';
import { m } from '@world/units';
import { sways, windDepthMaterial } from '@render/wind';

/** THE SUN'S CASCADES (`sunCascades.ts`): split by eye depth, fitted on whole texels, drawn only when what they hold changed */

const SIZE = 2048;
const flat = (): number => 0;

function rig() {
  const sun = new DirectionalLight();
  const others = [new DirectionalLight(), new DirectionalLight()];
  const cascades = createSunCascades(sun, others, 2);
  cascades.setEnabled(true, SIZE);
  // A street view: 28 m back from the point looked at, tilted 15 degrees down: the far side of the view is the horizon.
  const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
  camera.position.set(0, m(28) * Math.sin((15 * Math.PI) / 180), m(28) * Math.cos((15 * Math.PI) / 180));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const sunDirection = new Vector3(-0.5, 0.75, -0.3).normalize();
  return { cascades, camera, sunDirection, target: new Vector3(0, 0, 0) };
}

const halfOf = (light: DirectionalLight): number => light.shadow.camera.right;
const texelOf = (light: DirectionalLight): number => (2 * halfOf(light)) / SIZE;

describe('sun cascades', () => {
  it('splits the view into three cascades, each coarser and wider than the one before', () => {
    const { cascades, camera, sunDirection, target } = rig();
    expect(cascades.follow(camera, sunDirection, flat, target, m(40))).toBe(true);
    expect(cascades.lights).toHaveLength(SUN_CASCADES);
    const halves = cascades.lights.map(halfOf);
    expect(halves[0]!).toBeGreaterThan(m(5));
    expect(halves[1]!).toBeGreaterThan(halves[0]!);
    expect(halves[2]!).toBeGreaterThan(halves[1]!);
    // The nearest cascade a few centimetres a texel round the street looked at
    expect(texelOf(cascades.lights[0]!)).toBeLessThan(m(0.06));
    // The last reaches hundreds of metres down the street
    expect(halves[2]!).toBeGreaterThan(m(200));
  });

  it('puts every cascade on whole texels of the light and on the ladder of sizes', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    for (const light of cascades.lights) {
      const half = halfOf(light);
      // Half-sides are 2^(k/4) m
      const k = 4 * Math.log2(half / m(1));
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      // The light's centre, in its own right and up axes, a whole number of texels from the origin
      // Where three's shadow pass puts the light's camera (LightShadow.updateMatrices)
      light.shadow.updateMatrices(light);
      const camera3 = light.shadow.camera;
      const right = new Vector3().setFromMatrixColumn(camera3.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(camera3.matrixWorld, 1);
      const texel = texelOf(light);
      for (const along of [light.position.dot(right) / texel, light.position.dot(up) / texel]) {
        expect(Math.abs(along - Math.round(along))).toBeLessThan(1e-4);
      }
    }
  });

  it('draws the cascades again for safety one at a time, never all three in one frame (RND-03), each within its ten seconds (a last resort: the signature of the casters tells of every change)', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: true, effects: false });
    cascades.takeStats();
    const drawn = [0, 0, 0];
    for (let frame = 0; frame < 1800; frame++) {
      cascades.follow(camera, sunDirection, flat, target, m(40));
      cascades.pass({ changed: false, effects: false });
      const { whole } = cascades.takeStats();
      expect(whole.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
      whole.forEach((n, i) => { drawn[i]! += n; });
    }
    // Each still drawn for safety about every 600 frames: three times in 1800.
    for (const n of drawn) expect(n).toBeGreaterThanOrEqual(2);
  });

  it('keeps its cascades where they are while the view moves within their room, and draws none again for that', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    const before = cascades.lights.map((light) => light.position.clone());
    // Ten centimetres to the side
    camera.position.x += m(0.1);
    target.x += m(0.1);
    camera.updateMatrixWorld();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    expect(cascades.lights.map((light, i) => light.position.equals(before[i]!))).toEqual([true, true, true]);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false })).toBe(false);
  });

  it('moves the sun in steps of a tenth of a degree at the least, each cascade holding its own until a texel of shadow would move', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    const turned = (degrees: number): Vector3 => sunDirection.clone().applyAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180);
    expect(cascades.follow(camera, turned(0.05), flat, target, m(40))).toBe(false);
    expect(cascades.follow(camera, turned(0.2), flat, target, m(40))).toBe(true);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false })).toBe(true);
    // The near cascade, centimetres a texel, moved with the sun; the far one, metres a texel over a town 40 m tall, holds its sun: a fifth of a degree moves no shadow of its by a texel.
    expect(cascades.lights[0]!.shadow.needsUpdate).toBe(true);
    expect(cascades.lights[2]!.shadow.needsUpdate).toBe(false);
    expect(cascades.toSun.dot(turned(0.2))).toBeCloseTo(1, 9);
  });

  it('draws one cascade whole a frame for a sun that moved, the others their turn in the frames after', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    cascades.takeStats();
    // Three degrees: every cascade's sun left its tolerance.
    const turned = sunDirection.clone().applyAxisAngle(new Vector3(0, 1, 0), (3 * Math.PI) / 180);
    const drawn: (readonly number[])[] = [];
    for (let frame = 0; frame < 4; frame++) {
      cascades.follow(camera, turned, flat, target, m(40));
      for (const light of cascades.lights) light.shadow.needsUpdate = false;
      cascades.pass({ changed: false, effects: false });
      const { whole } = cascades.takeStats();
      drawn.push(whole);
      for (const light of cascades.lights) light.shadow.needsUpdate = false;
    }
    // One cascade whole a frame, nearest first; all three within three frames; nothing in the fourth.
    expect(drawn.map((w) => w.reduce((a, b) => a + b, 0))).toEqual([1, 1, 1, 0]);
    expect(drawn[0]).toEqual([1, 0, 0]);
    expect(drawn[1]).toEqual([0, 1, 0]);
    expect(drawn[2]).toEqual([0, 0, 1]);
  });

  it('draws again only the cascades a moving caster is wide enough to be drawn into', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    // Something ten centimetres across: wider than two texels of the nearest cascade, not of the farthest
    const small = new Mesh(new BoxGeometry(m(0.1), m(0.1), m(0.1)));
    small.updateMatrixWorld();
    cascades.setMovers([{ roots: [small], moving: () => true }]);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    cascades.pass({ changed: false, effects: false });
    const radius = small.geometry.boundingSphere!.radius;
    expect(cascades.lights.map((light) => light.shadow.needsUpdate)).toEqual(cascades.lights.map((light) => radius >= texelOf(light)));
    expect(cascades.lights[0]!.shadow.needsUpdate).toBe(true);
    expect(cascades.lights[2]!.shadow.needsUpdate).toBe(false);
    // Hidden from the far cascade's pass only, and put back after it
    cascades.lights[2]!.shadow.updateMatrices(cascades.lights[2]!);
    expect(small.visible).toBe(false);
    cascades.restore();
    expect(small.visible).toBe(true);
  });

  it("measures an instanced caster at its instances' size: a unit geometry scaled to a train car is drawn into the far cascade", () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    // A ten-centimetre box, each instance scaled to twenty metres.
    const cars = new InstancedMesh(new BoxGeometry(m(0.1), m(0.1), m(0.1)), new MeshBasicMaterial(), 2);
    for (let k = 0; k < 2; k++) cars.setMatrixAt(k, new Matrix4().makeScale(200, 200, 200).setPosition(k * m(30), 0, 0));
    cars.updateMatrixWorld();
    cascades.setMovers([{ roots: [cars], moving: () => true }]);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    cascades.pass({ changed: false, effects: false });
    expect(cascades.lights.map((light) => light.shadow.needsUpdate)).toEqual([true, true, true]);
    cascades.lights[2]!.shadow.updateMatrices(cascades.lights[2]!);
    expect(cars.visible).toBe(true);
    cascades.restore();
  });

  it('keeps each cascade\'s still casters: what moves is drawn over a copy of them, the town drawn again only when it changed', () => {
    const drawn: { lights: number; movers: boolean; cleared: boolean }[] = [];
    const town = new Object3D();
    const copies: string[] = [];
    let clears = 0;
    const renderer = {
      capabilities: { reversedDepthBuffer: false },
      clear: () => { clears++; },
      initRenderTarget: () => {},
      copyTextureToTexture: (from: { name: string }, to: { name: string }) => { copies.push(`${from.name}>${to.name}`); },
      getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget: () => {},
      shadowMap: {
        needsUpdate: false,
        // As three's: each light asked for drawn (its map cleared, then the scene's casters), then no longer asked for.
        render(lights: DirectionalLight[], scene: Object3D) {
          for (const light of lights) {
            if (!light.shadow.needsUpdate) continue;
            light.shadow.updateMatrices(light);
            const before = clears;
            renderer.clear();
            drawn.push({ lights: lights.indexOf(light), movers: scene !== town, cleared: clears > before });
            light.shadow.needsUpdate = false;
          }
        },
      },
    };
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    sun.castShadow = true;
    const cascades = createSunCascades(sun, others, 2, renderer as unknown as WebGLRenderer);
    cascades.setEnabled(true, 512);
    const car = new Mesh(new BoxGeometry(m(5), m(2), m(5)));
    car.castShadow = true;
    town.add(car);
    car.updateMatrixWorld();
    cascades.setMovers([{ roots: [car], moving: () => true }]);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    cascades.follow(camera, new Vector3(-0.5, 0.75, -0.3).normalize(), flat, new Vector3(), m(40));
    const frame = (): void => { renderer.shadowMap.render(cascades.lights as DirectionalLight[], town); cascades.restore(); };
    // The first frame, the scene still: every cascade drawn whole without the car, kept, and the car drawn over each without a clear (what the wind sways is a mover too, `wind.ts` markSway: the near cascades keep a store as the far one).
    expect(cascades.pass({ changed: false, effects: false, still: true })).toBe(true);
    const inTown: boolean[] = [];
    for (const light of cascades.lights) {
      const shadow = light.shadow, draw = shadow.updateMatrices.bind(shadow);
      shadow.updateMatrices = (l) => { draw(l); if (drawn.length < SUN_CASCADES) inTown.push(car.visible); };
    }
    frame();
    expect(inTown).toEqual([false, false, false]);
    const still = drawn.filter((d) => !d.movers), over = drawn.filter((d) => d.movers);
    expect(still.length).toBe(SUN_CASCADES);
    expect(over.length).toBe(SUN_CASCADES);
    expect(over.every((d) => !d.cleared)).toBe(true);
    expect(copies.filter((c) => c.endsWith('>')).length).toBe(SUN_CASCADES);
    // The car moves on, nothing else changed: no cascade drawn again, each put back from its copy and the car over it.
    drawn.length = 0; copies.length = 0;
    expect(cascades.pass({ changed: false, effects: false, still: true })).toBe(true);
    expect(cascades.lights.map((light) => light.shadow.needsUpdate)).toEqual([false, false, false]);
    frame();
    expect(drawn.filter((d) => !d.movers).length).toBe(0);
    expect(drawn.filter((d) => d.movers).length).toBe(SUN_CASCADES);
    expect(drawn.filter((d) => d.movers).every((d) => !d.cleared)).toBe(true);
    expect(copies.filter((c) => c.startsWith('>')).length).toBe(SUN_CASCADES);
    // Something landed or the view moved (not still): the far cascade's store stands for nothing, drawn whole, the car in the same pass: no copy kept, no second pass.
    drawn.length = 0; copies.length = 0;
    cascades.pass({ changed: false, effects: false, still: false });
    expect(cascades.lights[2]!.shadow.needsUpdate).toBe(true);
    frame();
    expect(drawn.every((d) => !d.movers)).toBe(true);
    expect(copies).toEqual([]);
    // The town changed: drawn whole again.
    drawn.length = 0;
    cascades.pass({ changed: true, effects: false });
    frame();
    expect(drawn.filter((d) => !d.movers).length).toBe(SUN_CASCADES);
    expect(car.visible).toBe(true);
  });

  it('draws over the store only the parts of a mover that cast, hold instances and reach the texel, not the mover whole', () => {
    const over: Object3D[][] = [];
    const renderer = {
      capabilities: { reversedDepthBuffer: false },
      clear: () => {}, initRenderTarget: () => {}, copyTextureToTexture: () => {},
      getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget: () => {},
      shadowMap: {
        needsUpdate: false,
        render(lights: DirectionalLight[], scene: Object3D) {
          for (const light of lights) {
            if (!light.shadow.needsUpdate) continue;
            light.shadow.updateMatrices(light);
            if (scene !== town) over.push([...scene.children]);
            light.shadow.needsUpdate = false;
          }
        },
      },
    };
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    const cascades = createSunCascades(sun, others, 2, renderer as unknown as WebGLRenderer);
    cascades.setEnabled(true, 512);
    const town = new Object3D();
    // A group of people's levels: one drawing three, one empty, one too small for any texel, one that casts no shadow.
    const people = new Group();
    const part = (size: number, count: number, casts = true): InstancedMesh => {
      const mesh = new InstancedMesh(new BoxGeometry(size, size, size), undefined, 4);
      mesh.count = count;
      mesh.castShadow = casts;
      people.add(mesh);
      return mesh;
    };
    const drawn = part(m(4), 3), empty = part(m(4), 0), tiny = part(m(0.001), 3), dark = part(m(4), 3, false);
    town.add(people);
    town.updateMatrixWorld(true);
    cascades.setMovers([{ roots: [people], moving: () => true }]);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    cascades.follow(camera, new Vector3(-0.5, 0.75, -0.3).normalize(), flat, new Vector3(), m(40));
    cascades.pass({ changed: false, effects: false, still: true });
    renderer.shadowMap.render(cascades.lights as DirectionalLight[], town);
    expect(over.length).toBeGreaterThan(0);
    for (const list of over) {
      expect(list).toContain(drawn);
      for (const left of [empty, tiny, dark, people]) expect(list).not.toContain(left);
    }
  });

  it('gives its maps and stores back with the shadows off, and makes them again when they are on (RND-21)', () => {
    const made: string[] = [];
    const renderer = {
      capabilities: { reversedDepthBuffer: false },
      clear: () => {}, initRenderTarget: () => { made.push('store'); }, copyTextureToTexture: () => {},
      getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget: () => {},
      shadowMap: {
        needsUpdate: false,
        render(lights: DirectionalLight[]) {
          for (const light of lights) {
            if (!light.shadow.needsUpdate) continue;
            light.shadow.updateMatrices(light);
            light.shadow.needsUpdate = false;
          }
        },
      },
    };
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    const cascades = createSunCascades(sun, others, 2, renderer as unknown as WebGLRenderer);
    cascades.setEnabled(true, 512);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const sunDirection = new Vector3(-0.5, 0.75, -0.3).normalize();
    const frame = (): void => {
      cascades.follow(camera, sunDirection, flat, new Vector3(), m(40));
      cascades.pass({ changed: false, effects: false, still: true });
      renderer.shadowMap.render(cascades.lights as DirectionalLight[]);
      cascades.restore();
    };
    frame();
    const held = (): number => cascades.maps().filter((t) => t !== null).length;
    expect(held()).toBe(2 * SUN_CASCADES);
    const disposed: number[] = [];
    cascades.maps().forEach((t, i) => t!.addEventListener('dispose', () => disposed.push(i)));
    // Off: no map, no store left on the GPU
    cascades.setEnabled(false, 512);
    expect(held()).toBe(0);
    expect(disposed.length).toBe(2 * SUN_CASCADES);
    made.length = 0;
    frame();
    expect(held()).toBe(0);
    expect(made).toEqual([]);
    // On again: every cascade drawn into maps and stores made again
    cascades.setEnabled(true, 512);
    frame();
    expect(held()).toBe(2 * SUN_CASCADES);
    expect(made.length).toBe(SUN_CASCADES);
  });

  it('lights the sun once in three\'s shaders, by the finest cascade that holds the point', () => {
    cascadedSunChunks();
    cascadedSunChunks();
    expect(ShaderChunk.shadowmap_pars_fragment.match(/float sunCascadeShadow\(/g)).toHaveLength(1);
    expect(ShaderChunk.lights_fragment_begin).toContain(`NUM_DIR_LIGHT_SHADOWS == ${SUN_CASCADES}`);
    // Three's own loop is kept for any other set of lights
    expect(ShaderChunk.lights_fragment_begin).toContain('#elif ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  });
});

describe('what the wind sways in the shadow', () => {
  it('is marked by its depth material, the plain depth is not; a mover of fixed size is measured once, not every frame', () => {
    expect(sways(windDepthMaterial({ bend: 0.5, flutter: 0.2, height: 4 } as unknown as Parameters<typeof windDepthMaterial>[0], 'test'))).toBe(true);
    expect(sways(new MeshBasicMaterial())).toBe(false);
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    sun.castShadow = true;
    const cascades = createSunCascades(sun, others, 2);
    cascades.setEnabled(true, 512);
    const trees = new InstancedMesh(new BoxGeometry(m(4), m(8), m(4)), new MeshBasicMaterial(), 2);
    trees.castShadow = true;
    trees.updateMatrixWorld();
    let reads = 0;
    const matrices = trees.instanceMatrix;
    const array = matrices.array;
    Object.defineProperty(matrices, 'array', { get: () => { reads++; return array; } });
    cascades.setMovers([{ roots: [trees], moving: () => true, fixedSize: true }]);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    cascades.follow(camera, new Vector3(-0.5, 0.75, -0.3).normalize(), flat, new Vector3(), m(40));
    cascades.pass({ changed: false, effects: false, still: true });
    const first = reads;
    for (let frame = 0; frame < 5; frame++) cascades.pass({ changed: false, effects: false, still: true });
    expect(first).toBeGreaterThan(0);
    expect(reads).toBe(first);
  });
});

describe('the sun the layers cull their shadows by', () => {
  it('scrolls a cascade\'s store with the view: the overlap blitted by whole texels, the strips uncovered cleared and drawn alone, the town never drawn whole for a pan', () => {
    const blits: number[][] = [];
    const clears: { scissor: number[] | null; depth: boolean }[] = [];
    const draws: { lights: number; left: number; right: number; bottom: number; top: number; viewport: number[]; movers: boolean }[] = [];
    const copies: string[] = [];
    const town = new Object3D();
    let bound: unknown = null;
    const gl = {
      READ_FRAMEBUFFER: 1, DRAW_FRAMEBUFFER: 2, DEPTH_BUFFER_BIT: 256, NEAREST: 9728,
      blitFramebuffer: (...args: number[]) => { blits.push(args); },
    };
    const renderer = {
      capabilities: { reversedDepthBuffer: false },
      getContext: () => gl,
      properties: { get: () => ({ __webglFramebuffer: {} }) },
      state: { setScissorTest: () => {}, bindFramebuffer: () => {}, buffers: { depth: { setMask: () => {} } } },
      clear: (_color = true, depth = true) => {
        const target = bound as { scissorTest: boolean; scissor: { x: number; y: number; z: number; w: number } } | null;
        clears.push({ scissor: target?.scissorTest ? [target.scissor.x, target.scissor.y, target.scissor.z, target.scissor.w] : null, depth });
      },
      initRenderTarget: () => {},
      copyTextureToTexture: (from: { name: string }, to: { name: string }) => { copies.push(`${from.name}>${to.name}`); },
      getRenderTarget: () => bound, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
      setRenderTarget: (target: unknown) => { bound = target; },
      shadowMap: {
        needsUpdate: false,
        render(lights: DirectionalLight[], scene: Object3D) {
          for (const light of lights) {
            if (!light.shadow.needsUpdate) continue;
            light.shadow.updateMatrices(light);
            bound = light.shadow.map;
            renderer.clear();
            const c = light.shadow.camera as OrthographicCamera;
            const viewport = (light.shadow as unknown as { _viewports: { toArray(): number[] }[] })._viewports[0]!.toArray();
            draws.push({ lights: lights.indexOf(light), left: c.left, right: c.right, bottom: c.bottom, top: c.top, viewport, movers: scene !== town });
            light.shadow.needsUpdate = false;
          }
        },
      },
    };
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    sun.castShadow = true;
    const cascades = createSunCascades(sun, others, 2, renderer as unknown as WebGLRenderer);
    const MAP = 512;
    cascades.setEnabled(true, MAP);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const sunDirection = new Vector3(-0.5, 0.75, -0.3).normalize();
    // The light's right axis, as the cascades take it (`SunHold.take`: up crossed with the sun): a move along it scrolls the map along its own x alone.
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), sunDirection).normalize();
    const target = new Vector3();
    const frame = (still: boolean): boolean => {
      const any = cascades.pass({ changed: false, effects: false, still });
      renderer.shadowMap.render(cascades.lights as DirectionalLight[], town);
      cascades.restore();
      return any;
    };
    // The first frame, still: every cascade drawn whole and kept.
    cascades.follow(camera, sunDirection, flat, target, m(40));
    expect(frame(true)).toBe(true);
    expect(cascades.takeStats().whole).toEqual([1, 1, 1]);
    const light = cascades.lights[0]!;
    const half = light.shadow.camera.right;
    const texel = (2 * half) / MAP;
    const before = light.position.clone();
    draws.length = 0;
    clears.length = 0;
    copies.length = 0;
    // The view led half the near cascade's half-side along the light's right: past its room (a fifth to two fifths of its half-side), its square moves by whole texels along the map's x; the far cascades' room holds them.
    const step = half * 0.45;
    camera.position.addScaledVector(right, step);
    target.addScaledVector(right, step);
    camera.updateMatrixWorld();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    expect(light.position.equals(before)).toBe(false);
    expect(frame(true)).toBe(true);
    const stats = cascades.takeStats();
    expect(stats.whole).toEqual([0, 0, 0]);
    expect(stats.why['scroll']).toBe(1);
    // One blit of the overlap, by whole texels, the same size either side.
    expect(blits).toHaveLength(1);
    const [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1] = blits[0]!;
    expect(sx1! - sx0!).toBe(dx1! - dx0!);
    expect(sy1! - sy0!).toBe(dy1! - dy0!);
    const shiftX = (sx0! - dx0!), shiftY = (sy0! - dy0!);
    expect(Math.abs(shiftX)).toBeGreaterThan(0);
    expect(shiftY).toBe(0);
    expect(Math.abs(shiftX)).toBeLessThan(MAP / 2);
    expect(sx1! - sx0!).toBe(MAP - Math.abs(shiftX));
    // Each strip uncovered cleared under a scissor as wide as the shift, then drawn with the camera narrowed to it and the viewport on it; the full square and viewport put back after.
    const scissored = clears.filter((c) => c.scissor !== null);
    expect(scissored.length).toBe((shiftX !== 0 ? 1 : 0) + (shiftY !== 0 ? 1 : 0));
    const strips = draws.filter((d) => !d.movers);
    expect(strips.length).toBe(scissored.length);
    for (const strip of strips) {
      expect(strip.right - strip.left).toBeLessThan(2 * half - 1e-6);
      expect(strip.viewport[2]! * strip.viewport[3]!).toBeLessThan(1);
      expect((strip.right - strip.left) * (strip.top - strip.bottom) / (4 * half * half)).toBeCloseTo(strip.viewport[2]! * strip.viewport[3]!, 6);
    }
    expect(light.shadow.camera.left).toBeCloseTo(-half, 9);
    expect(light.shadow.camera.right).toBeCloseTo(half, 9);
    expect((light.shadow as unknown as { _viewports: { toArray(): number[] }[] })._viewports[0]!.toArray()).toEqual([0, 0, 1, 1]);
    // The map copied to the store after, as after a whole draw; the shadow's matrix is the full square's at the new centre.
    expect(copies).toEqual([`${light.name}.shadowMap>`]);
    const centre = new Vector3().setFromMatrixPosition(light.matrixWorld);
    const projected = centre.clone().applyMatrix4(light.shadow.matrix);
    expect(projected.x).toBeCloseTo(0.5, 6);
    expect(projected.y).toBeCloseTo(0.5, 6);
    // The next frame, still again: nothing drawn.
    cascades.follow(camera, sunDirection, flat, target, m(40));
    for (const l of cascades.lights) l.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false, still: true })).toBe(false);
    expect(texel).toBeGreaterThan(0);
  });

  it('draws a store again only under the box of the casters that changed, the rest of the town standing; a change with no box throws the store away', () => {
    const draws: { left: number; right: number; bottom: number; top: number; viewport: number[] }[] = [];
    const clears: (number[] | null)[] = [];
    let bound: unknown = null;
    const renderer = {
      capabilities: { reversedDepthBuffer: false },
      getContext: () => ({ READ_FRAMEBUFFER: 1, DRAW_FRAMEBUFFER: 2, DEPTH_BUFFER_BIT: 256, NEAREST: 9728, blitFramebuffer: () => {} }),
      properties: { get: () => ({ __webglFramebuffer: {} }) },
      state: { setScissorTest: () => {}, bindFramebuffer: () => {}, buffers: { depth: { setMask: () => {} } } },
      clear: () => {
        const target = bound as { scissorTest: boolean; scissor: { x: number; y: number; z: number; w: number } } | null;
        clears.push(target?.scissorTest ? [target.scissor.x, target.scissor.y, target.scissor.z, target.scissor.w] : null);
      },
      initRenderTarget: () => {},
      copyTextureToTexture: () => {},
      getRenderTarget: () => bound, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
      setRenderTarget: (target: unknown) => { bound = target; },
      shadowMap: {
        needsUpdate: false,
        render(lights: DirectionalLight[]) {
          for (const light of lights) {
            if (!light.shadow.needsUpdate) continue;
            light.shadow.updateMatrices(light);
            bound = light.shadow.map;
            renderer.clear();
            const c = light.shadow.camera as OrthographicCamera;
            draws.push({ left: c.left, right: c.right, bottom: c.bottom, top: c.top, viewport: (light.shadow as unknown as { _viewports: { toArray(): number[] }[] })._viewports[0]!.toArray() });
            light.shadow.needsUpdate = false;
          }
        },
      },
    };
    const sun = new DirectionalLight(), others = [new DirectionalLight(), new DirectionalLight()];
    sun.castShadow = true;
    const cascades = createSunCascades(sun, others, 2, renderer as unknown as WebGLRenderer);
    cascades.setEnabled(true, 512);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const sunDirection = new Vector3(-0.5, 0.75, -0.3).normalize();
    const frame = (input: Parameters<typeof cascades.pass>[0]): boolean => {
      cascades.follow(camera, sunDirection, flat, new Vector3(), m(40));
      const any = cascades.pass(input);
      renderer.shadowMap.render(cascades.lights as DirectionalLight[]);
      cascades.restore();
      return any;
    };
    expect(frame({ changed: false, effects: false, still: true })).toBe(true);
    expect(cascades.takeStats().whole).toEqual([1, 1, 1]);
    draws.length = 0;
    clears.length = 0;
    // A building of 10 m square and 20 m tall changed at the point looked at: each cascade drawn again under it alone, on whole texels with a texel of margin, the near one over a few hundredths of its square.
    const box = new Box3(new Vector3(m(-5), 0, m(-5)), new Vector3(m(5), m(20), m(5)));
    expect(frame({ changed: false, effects: false, still: false, patch: [box] })).toBe(true);
    const stats = cascades.takeStats();
    expect(stats.whole).toEqual([0, 0, 0]);
    expect(stats.why['patch']).toBe(3);
    expect(stats.why['noStore']).toBe(0);
    expect(draws).toHaveLength(3);
    expect(clears.filter((c) => c !== null)).toHaveLength(3);
    for (const [i, draw] of draws.entries()) {
      const half = cascades.lights[i]!.shadow.camera.right;
      const share = ((draw.right - draw.left) * (draw.top - draw.bottom)) / (4 * half * half);
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(0.5);
      expect(share).toBeCloseTo(draw.viewport[2]! * draw.viewport[3]!, 6);
      expect(cascades.lights[i]!.shadow.camera.left).toBeCloseTo(-half, 9);
    }
    // A box far outside the near cascade's square: the near store stands untouched, the far ones patched.
    draws.length = 0;
    const far = new Box3(new Vector3(m(600), 0, m(-600)), new Vector3(m(610), m(5), m(-590)));
    frame({ changed: false, effects: false, still: false, patch: [far] });
    expect(cascades.takeStats().whole).toEqual([0, 0, 0]);
    expect(draws.length).toBeLessThan(3);
    // No box to tell: every store thrown away (nothing drawn for that alone, as before: a change the layers draw asks with `changed`), so a mover moving next draws the town whole, no patch.
    draws.length = 0;
    frame({ changed: false, effects: false, still: false, patch: null });
    expect(draws).toHaveLength(0);
    const car = new Mesh(new BoxGeometry(m(5), m(2), m(5)));
    car.castShadow = true;
    car.updateMatrixWorld();
    cascades.setMovers([{ roots: [car], moving: () => true }]);
    frame({ changed: false, effects: false, still: true, patch: [box] });
    const after = cascades.takeStats();
    expect(after.whole).toEqual([1, 1, 1]);
    expect(after.why['patch']).toBe(0);
  });

  it('stays the same bits while the cascades fit again under a sun that did not move', () => {
    const { cascades, camera, sunDirection } = rig();
    const told: string[] = [];
    const subtracted: string[] = [];
    // The ground coming in under a camera standing still, and the camera led along a street: each fit puts the lights elsewhere.
    for (let i = 0; i < 24; i++) {
      cascades.follow(camera, sunDirection, (x, y) => Math.sin(x * 0.01 + i) * m(3) + y * 0, new Vector3(m(37) * i, 0, m(-11) * i), m(40 + i * 7));
      const light = cascades.lights[0]!;
      told.push(cascades.toSun.toArray().join());
      subtracted.push(light.position.clone().sub(light.target.position).toArray().join());
    }
    // The light's position less its target moved by its last bits (what every layer took for a sun moved, and culled again)
    expect(new Set(subtracted).size).toBeGreaterThan(1);
    expect(new Set(told).size).toBe(1);
    expect(cascades.toSun.length()).toBeCloseTo(1, 12);
    expect(cascades.toSun.dot(sunDirection)).toBeCloseTo(1, 9);
  });
});
