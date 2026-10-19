import { describe, expect, it } from 'vitest';
import { DirectionalLight, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, BoxGeometry, Object3D, PerspectiveCamera, ShaderChunk, Vector3, type WebGLRenderer } from 'three';

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

  it('moves the sun in steps of a tenth of a degree, every cascade with it', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false });
    const turned = (degrees: number): Vector3 => sunDirection.clone().applyAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180);
    expect(cascades.follow(camera, turned(0.05), flat, target, m(40))).toBe(false);
    expect(cascades.follow(camera, turned(0.2), flat, target, m(40))).toBe(true);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false })).toBe(true);
    expect(cascades.lights.every((light) => light.shadow.needsUpdate)).toBe(true);
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
