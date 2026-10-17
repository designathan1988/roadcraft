import { describe, expect, it } from 'vitest';
import { DirectionalLight, Mesh, BoxGeometry, Object3D, PerspectiveCamera, ShaderChunk, Vector3, type WebGLRenderer } from 'three';

import { cascadedSunChunks, createSunCascades, SUN_CASCADES } from '@render/sunCascades';
import { m } from '@world/units';

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
    cascades.pass({ changed: false, effects: false, wind: false });
    const before = cascades.lights.map((light) => light.position.clone());
    // Ten centimetres to the side
    camera.position.x += m(0.1);
    target.x += m(0.1);
    camera.updateMatrixWorld();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    expect(cascades.lights.map((light, i) => light.position.equals(before[i]!))).toEqual([true, true, true]);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false, wind: false })).toBe(false);
  });

  it('moves the sun in steps of a tenth of a degree, every cascade with it', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false, wind: false });
    const turned = (degrees: number): Vector3 => sunDirection.clone().applyAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180);
    expect(cascades.follow(camera, turned(0.05), flat, target, m(40))).toBe(false);
    expect(cascades.follow(camera, turned(0.2), flat, target, m(40))).toBe(true);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    expect(cascades.pass({ changed: false, effects: false, wind: false })).toBe(true);
    expect(cascades.lights.every((light) => light.shadow.needsUpdate)).toBe(true);
  });

  it('draws again only the cascades a moving caster is wide enough to be drawn into', () => {
    const { cascades, camera, sunDirection, target } = rig();
    cascades.follow(camera, sunDirection, flat, target, m(40));
    cascades.pass({ changed: false, effects: false, wind: false });
    // Something ten centimetres across: wider than two texels of the nearest cascade, not of the farthest
    const small = new Mesh(new BoxGeometry(m(0.1), m(0.1), m(0.1)));
    small.updateMatrixWorld();
    cascades.setMovers([{ roots: [small], moving: () => true }]);
    for (const light of cascades.lights) light.shadow.needsUpdate = false;
    cascades.pass({ changed: false, effects: false, wind: false });
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
    town.add(car);
    car.updateMatrixWorld();
    cascades.setMovers([{ roots: [car], moving: () => true }]);
    const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
    camera.position.set(0, m(10), m(30));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    cascades.follow(camera, new Vector3(-0.5, 0.75, -0.3).normalize(), flat, new Vector3(), m(40));
    const frame = (): void => { renderer.shadowMap.render(cascades.lights as DirectionalLight[], town); cascades.restore(); };
    // The first frame: every cascade drawn whole without the car, kept, and the car drawn over it without a clear.
    expect(cascades.pass({ changed: false, effects: false, wind: false })).toBe(true);
    let visibleInTown = true;
    const shadow0 = cascades.lights[0]!.shadow;
    const draw = shadow0.updateMatrices.bind(shadow0);
    shadow0.updateMatrices = (light) => { draw(light); if (drawn.length === 0) visibleInTown = car.visible; };
    frame();
    expect(visibleInTown).toBe(false);
    const still = drawn.filter((d) => !d.movers), over = drawn.filter((d) => d.movers);
    expect(still.length).toBe(SUN_CASCADES);
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((d) => !d.cleared)).toBe(true);
    expect(copies.length).toBe(SUN_CASCADES);
    expect(copies.every((c) => c.includes('.shadowMap>'))).toBe(true);
    // The car moves on, nothing else changed: the far cascade not drawn again, only put back from its copy and the car over it; the near two drawn whole (the plants sway in them, `wind.ts`).
    drawn.length = 0; copies.length = 0;
    expect(cascades.pass({ changed: false, effects: false, wind: false, still: true })).toBe(true);
    expect(cascades.lights.map((light) => light.shadow.needsUpdate)).toEqual([true, true, false]);
    frame();
    expect(drawn.filter((d) => !d.movers).length).toBe(SUN_CASCADES - 1);
    expect(drawn.filter((d) => d.movers).every((d) => !d.cleared)).toBe(true);
    expect(copies.filter((c) => c.startsWith('>')).length).toBe(1);
    // Something landed or the view moved (not still): the far cascade's store stands for nothing, drawn whole.
    drawn.length = 0;
    cascades.pass({ changed: false, effects: false, wind: false, still: false });
    expect(cascades.lights[2]!.shadow.needsUpdate).toBe(true);
    frame();
    // The town changed: drawn whole again.
    drawn.length = 0;
    cascades.pass({ changed: true, effects: false, wind: false });
    frame();
    expect(drawn.filter((d) => !d.movers).length).toBe(SUN_CASCADES);
    expect(car.visible).toBe(true);
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
