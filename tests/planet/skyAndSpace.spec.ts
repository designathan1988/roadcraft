import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AdditiveBlending, BufferAttribute, CustomBlending, Matrix3, Matrix4, Mesh, OneFactor, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3, ZeroFactor,
  type WebGLRenderer,
} from 'three';

import { PLANET_RADIUS } from '@core/cubeSphere';
import { airWork, ATMOSPHERE_TOP, createAir } from '../../src/render/planet/air';
import { flightNow } from '../../src/render/planet/flight';
import { cometAt, createSkyLife, dustWeights, DUST_BOXES, type SkyLifeFrame } from '../../src/render/planet/skyLife';
import { createSpace } from '../../src/render/planet/space';

/**
 * THE SKY AND SPACE (F5, the player 2026-10-11: "mais dinâmica e coisas para
 * explorar", "efeitos especiais bonitos e otimizados", "atmosfera melhor com
 * zoom próximo e intermediário").
 *
 * - The air round the eye is made over the ground as drawn (R / k), whose
 *   horizon's air mass is the Earth's, not over the planet's small sphere
 *   (4.7 against ~38): the street's sky was a flat navy to the ground line.
 * - From space the air's shell is depth tested: the moon, a rock or the
 *   station in front of the planet hides it (the blue ring showed through the
 *   moon's ground).
 * - Something to fly to and watch: a comet on a Keplerian orbit with its tails
 *   away from the sun, the station's navigation lights, the aurora; and the
 *   space dust that makes a flight's speed seen.
 */

const R = PLANET_RADIUS;

/** A renderer that draws nothing and remembers the targets drawn into. */
function fakeRenderer(): WebGLRenderer & { drawnInto: unknown[] } {
  let target: unknown = null;
  const drawnInto: unknown[] = [];
  return {
    drawnInto,
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => { target = t; },
    compileAsync: () => Promise.resolve(),
    render: () => { drawnInto.push(target); },
    getPixelRatio: () => 1,
  } as unknown as WebGLRenderer & { drawnInto: unknown[] };
}
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('the air over the ground as drawn', () => {
  const airFrame = (drawnRadius: number) => ({
    centre: new Vector3(0, -R, 0), eye: new Vector3(0, 12, 0), sun: new Vector3(0.3, 0.9, 0).normalize(), moon: new Vector3(0, -1, 0),
    moonLight: 0, drawnCentre: new Vector3(0, -drawnRadius, 0), drawnRadius,
  });

  it('makes the sky round the eye over the flattened ground, with that ground\'s own LUTs', async () => {
    const gl = fakeRenderer();
    const air = createAir(gl);
    await settle();
    air.update(gl, airFrame(R / 0.02));
    expect(air.inside).toBe(true);
    expect(air.uniforms['uAirDrawnR']!.value).toBeCloseTo(R / 0.02, 3);
    expect(air.uniforms['uAirDrawnTop']!.value).toBeCloseTo(R / 0.02 + (ATMOSPHERE_TOP - R), 3);
    expect((air.uniforms['uAirDrawnCentre']!.value as Vector3).y).toBeCloseTo(-R / 0.02, 3);
    // Its transmittance and multiple scattering baked for it, not the planet's.
    expect(air.uniforms['tAirTransmittanceD']!.value).not.toBe(air.uniforms['tAirTransmittance']!.value);
    expect(air.uniforms['tAirMultiD']!.value).not.toBe(air.uniforms['tAirMulti']!.value);
    expect(air.drawnBakes).toEqual({ transmittance: 1, multi: 1 });
  });

  it('bakes them again only when the drawn ground moves, and at most once a frame (airWork)', async () => {
    const gl = fakeRenderer();
    const air = createAir(gl);
    await settle();
    const before = airWork.drawnBakeFrames;
    air.update(gl, airFrame(R / 0.02));
    air.update(gl, airFrame(R / 0.02));
    expect(air.drawnBakes).toEqual({ transmittance: 1, multi: 1 });
    // A zoom through the whole flattened range, a step a frame: never more than one bake a frame.
    for (let k = 0.02; k <= 1; k += 0.01) {
      const was = airWork.drawnBakeFrames;
      air.update(gl, airFrame(R / k));
      expect(airWork.drawnBakeFrames - was).toBeLessThanOrEqual(1);
    }
    expect(airWork.drawnBakeFrames - before).toBeGreaterThan(1);
    const restart = createAir(gl);
    await settle();
    restart.update(gl, airFrame(R / 0.02));
    // 1 % flatter: the transmittance again, the smooth multiple scattering not yet.
    restart.update(gl, airFrame((R / 0.02) * 1.01));
    expect(restart.drawnBakes).toEqual({ transmittance: 2, multi: 1 });
    restart.update(gl, airFrame((R / 0.02) * 1.06));
    expect(restart.drawnBakes).toEqual({ transmittance: 3, multi: 2 });
  });

  it('is the planet\'s own air when the ground is drawn round the planet (k = 1, and from space)', async () => {
    const gl = fakeRenderer();
    const air = createAir(gl);
    await settle();
    air.update(gl, airFrame(R));
    expect(air.uniforms['uAirDrawnR']!.value).toBe(R);
    expect(air.uniforms['tAirTransmittanceD']!.value).toBe(air.uniforms['tAirTransmittance']!.value);
    expect(air.drawnBakes).toEqual({ transmittance: 0, multi: 0 });
  });

  it('gives the flattened ground an air mass at the horizon near the Earth\'s', () => {
    // The relative air mass of a horizontal ray from the ground through an
    // exponential air of scale height H round a sphere of radius r:
    // sqrt(pi r / (2 H)) (the Chapman function at 90 degrees, large r / H).
    const H = R * 0.07;
    const airMass = (r: number): number => Math.sqrt((Math.PI * r) / (2 * H));
    const earth = Math.sqrt((Math.PI * 6360) / (2 * 8));
    console.log(`horizon air mass: planet ${airMass(R).toFixed(1)}, drawn ground ${airMass(R / 0.02).toFixed(1)}, Earth ${earth.toFixed(1)}`);
    expect(airMass(R)).toBeLessThan(earth / 4);
    expect(Math.abs(airMass(R / 0.02) - earth) / earth).toBeLessThan(0.2);
  });
});

describe('the sky\'s added light', () => {
  it('adds its colour and leaves the alpha under it as it is (the sun\'s quad was a lighter rectangle at dawn)', async () => {
    const scene = new Scene();
    const space = createSpace(scene, fakeRenderer());
    await settle();
    const life = createSkyLife();
    const added: string[] = [];
    for (const root of [scene, life.group]) {
      root.traverse((o) => {
        const m = (o as Mesh).material;
        if (!m || Array.isArray(m)) return;
        // three's AdditiveBlending adds to the alpha as well (`WebGLState` setBlending).
        expect(m.blending, o.name).not.toBe(AdditiveBlending);
        // Every blend of the sky's own: the air's shell over the scene, the light added.
        if (m.blending === CustomBlending) {
          added.push(o.name);
          expect([m.blendSrcAlpha, m.blendDstAlpha], o.name).toEqual([ZeroFactor, OneFactor]);
        }
      });
    }
    // The stars, the Milky Way, the sun, and the sky's life (comet, aurora, lamps, dust...).
    expect(added).toContain('space-air');
    expect(added.length).toBeGreaterThanOrEqual(10);
    life.dispose();
    space.dispose();
  });
});

describe('the air\'s shell seen from space', () => {
  const frame = (camera: PerspectiveCamera) => ({
    camera, globe: 1, dark: 0, minutes: 720, sun: new Vector3(1, 0, 0), centre: new Vector3(0, 0, 0), motion: new Matrix4(), height: 720, pixelRatio: 1,
  });

  it('is hidden behind what stands in front of the planet: depth tested at its own depth from out in space', async () => {
    const scene = new Scene();
    const space = createSpace(scene, fakeRenderer());
    await settle();
    const air = scene.getObjectByName('space-air') as Mesh;
    const material = air.material as ShaderMaterial;
    const camera = new PerspectiveCamera(55, 16 / 9, 50, 1e6);
    camera.position.set(0, 0, 10 * R);
    camera.updateMatrixWorld();
    space.update(frame(camera));
    expect(material.depthTest).toBe(true);
    expect(material.uniforms['uFront']!.value).toBe(1);
    // Inside the air: the far face at the far plane, depth tested (the sky behind everything).
    camera.position.set(0, 0, R + 100);
    space.update(frame(camera));
    expect(material.depthTest).toBe(true);
    expect(material.uniforms['uFront']!.value).toBe(0);
    // Just out of it, within twice the near plane: the far face, untested (no hole cut by the near plane).
    camera.position.set(0, 0, ATMOSPHERE_TOP + 40);
    space.update(frame(camera));
    expect(material.uniforms['uFront']!.value).toBe(0);
    expect(material.depthTest).toBe(false);
    space.dispose();
  });

  it('lists its bodies without making a list a frame, and the comet among all of them', async () => {
    const space = createSpace(new Scene(), fakeRenderer());
    await settle();
    expect(space.bodies()).toBe(space.bodies());
    expect(space.allBodies().map((b) => b.name)).toEqual(['moon', 'sun', 'station', 'comet']);
    space.dispose();
  });
});

describe('the sun and the moon close by (AS15)', () => {
  const frame = (camera: PerspectiveCamera) => ({
    camera, globe: 1, dark: 0, minutes: 600, sun: new Vector3(1, 0, 0), centre: new Vector3(0, 0, 0), motion: new Matrix4(), height: 720, pixelRatio: 1,
  });

  it('exposes the moon close by as a camera would its sunlit ground: grey highlands, not a white plaster ball', async () => {
    const scene = new Scene();
    const space = createSpace(scene, fakeRenderer());
    await settle();
    const gain = ((scene.getObjectByName('space-moon') as Mesh).material as ShaderMaterial).uniforms['uGain']!;
    const camera = new PerspectiveCamera(55, 16 / 9, 1, 1e9);
    camera.position.set(0, 0, R + 100);
    camera.updateMatrixWorld();
    space.update(frame(camera));
    // A disc in the sky from the ground: bright against the blue.
    expect(gain.value).toBeGreaterThan(8);
    const body = space.bodies().find((b) => b.name === 'moon')!;
    // From three of its radii (it fills a third of the view): the highlands' albedo 0.14 under 0.3 of light.
    camera.position.copy(body.centre).addScaledVector(new Vector3(0, 0, 1), body.radius * 3);
    camera.updateMatrixWorld();
    space.update(frame(camera));
    expect(0.14 * gain.value).toBeLessThan(0.3);
    space.dispose();
  });

  it('lights the moon only to the smooth sphere\'s terminator (the bump alone lit white specks over its night)', async () => {
    const scene = new Scene();
    const space = createSpace(scene, fakeRenderer());
    await settle();
    const source = ((scene.getObjectByName('space-moon') as Mesh).material as ShaderMaterial).fragmentShader;
    expect(source).toMatch(/lit \*= smoothstep\([^;]*dot\(normalize\(vNormal\), uSun\)\)/);
    space.dispose();
  });
});

describe('the sky\'s life', () => {
  const lifeCamera = (): PerspectiveCamera => {
    const camera = new PerspectiveCamera(55, 16 / 9, 1, 1e6);
    camera.position.set(0, 0, 3 * R);
    return camera;
  };
  const lifeFrame = (seconds = 0.1): SkyLifeFrame => ({
    camera: lifeCamera(),
    motion: new Matrix4(), sky: new Matrix3(), centre: new Vector3(), sun: new Vector3(1, 0, 0), sunBody: new Vector3(60 * R, 0, 0),
    seconds, pixelRatio: 1, height: 720, width: 1280, airUniforms: { uAirInside: { value: 0 } },
  });

  it('has a comet on a Keplerian ellipse: 9 to 27 radii out, fastest at its nearest, back where it was after a turn', () => {
    const at = new Vector3(), v = new Vector3();
    let nearest = Infinity, farthest = 0, fastest = 0, slowest = Infinity;
    for (let t = 0; t < 2400; t += 1) {
      cometAt(t, at, v);
      nearest = Math.min(nearest, at.length());
      farthest = Math.max(farthest, at.length());
      fastest = Math.max(fastest, v.length());
      slowest = Math.min(slowest, v.length());
    }
    expect(nearest / R).toBeCloseTo(9, 1);
    expect(farthest / R).toBeCloseTo(27, 1);
    // Kepler's second law: the speeds at the apsides go as (1 + e) / (1 - e) = 3.
    expect(fastest / slowest).toBeCloseTo(3, 1);
    const again = new Vector3();
    cometAt(100, at, v);
    cometAt(2500, again, v);
    expect(again.distanceTo(at)).toBeLessThan(1);
    // The velocity is the motion's own: a step of a second moves it by it.
    const next = new Vector3();
    cometAt(100, at, v);
    cometAt(100.01, next, new Vector3());
    expect(next.sub(at).divideScalar(0.01).distanceTo(v)).toBeLessThan(v.length() * 1e-3);
  });

  it('points the comet\'s tails away from the sun, the dust tail curving back along its orbit', () => {
    const life = createSkyLife();
    const frame = lifeFrame();
    life.update(frame);
    const glow = life.group.getObjectByName('space-comet') as Mesh;
    const u = (glow.material as ShaderMaterial).uniforms;
    const away = (u['uAway']!.value as Vector3).clone();
    const fromSun = life.comet.centre.clone().sub(frame.sunBody).normalize();
    expect(away.dot(fromSun)).toBeGreaterThan(0.9999);
    expect(Math.abs((u['uBack']!.value as Vector3).dot(away))).toBeLessThan(1e-6);
    expect(life.comet.centre.length() / R).toBeGreaterThan(8.9);
    // A ship come up beside the nucleus flies on with it.
    const drift = life.driftAt(life.comet.centre.clone().add(new Vector3(500, 0, 0)), new Vector3());
    const v = new Vector3();
    cometAt(0.1, new Vector3(), v);
    expect(drift.distanceTo(v)).toBeLessThan(v.length() * 0.01);
    life.dispose();
  });

  it('lights the station: red to port, green to starboard, strobes that flash', () => {
    const life = createSkyLife();
    const lights = life.group.getObjectByName('space-station-lights') as Points;
    expect(lights).toBeTruthy();
    const colour = lights.geometry.getAttribute('aColour') as BufferAttribute;
    const blink = lights.geometry.getAttribute('aBlink') as BufferAttribute;
    let red = false, green = false, strobe = false;
    for (let i = 0; i < colour.count; i++) {
      if (colour.getX(i) > 0.9 && colour.getY(i) < 0.2) red = true;
      if (colour.getY(i) > 0.9 && colour.getX(i) < 0.2) green = true;
      if (blink.getZ(i) >= 2 && blink.getW(i) < 0.1) strobe = true;
    }
    expect([red, green, strobe]).toEqual([true, true, true]);
    life.dispose();
  });

  it('sets the aurora by the sun in the planet\'s own frame (its night side), whatever way the planet is set down', () => {
    const life = createSkyLife();
    const frame = lifeFrame();
    // The planet set down turned a quarter about three's y.
    frame.motion = new Matrix4().makeRotationY(Math.PI / 2);
    life.update(frame);
    const aurora = life.group.getObjectByName('space-aurora') as Mesh;
    const sunLocal = (aurora.material as ShaderMaterial).uniforms['uSunLocal']!.value as Vector3;
    const expected = new Vector3(1, 0, 0).applyMatrix4(new Matrix4().makeRotationY(-Math.PI / 2));
    expect(sunLocal.distanceTo(expected)).toBeLessThan(1e-6);
    // Both ovals: a curtain round each and the glow under it seen from above, two rows each.
    expect((aurora.geometry.getAttribute('aAurora') as BufferAttribute).count).toBe(4 * 361 * 2);
    life.dispose();
  });

  it('shows the space dust only while flying, a scale for any flying speed and none at rest', () => {
    const weights: number[] = [];
    expect(Math.max(...dustWeights(0, weights))).toBe(0);
    for (const speed of [8, 25, 120, 900, 7000, 38_000]) {
      dustWeights(speed, weights);
      expect(Math.max(...weights), `at ${speed} m/s`).toBeGreaterThan(0.99);
    }
    expect(weights.length).toBe(DUST_BOXES.length);
    const life = createSkyLife();
    const dust = life.group.getObjectByName('space-dust') as Mesh;
    flightNow.active = false;
    life.update(lifeFrame());
    expect(dust.visible).toBe(false);
    flightNow.active = true;
    flightNow.velocity.set(0, 0, -900);
    life.update(lifeFrame());
    expect(dust.visible).toBe(true);
    const shown = ((dust.material as ShaderMaterial).uniforms['uWeight']!.value as number[]);
    expect(Math.max(...shown)).toBeGreaterThan(0.99);
    flightNow.active = false;
    flightNow.velocity.set(0, 0, 0);
    life.dispose();
  });

  it('streaks the view with the speed: none at rest, a few at a cruise, the jump many; towards where the ship flies', () => {
    const life = createSkyLife();
    const streaks = life.group.getObjectByName('space-streaks') as Mesh;
    const u = (streaks.material as ShaderMaterial).uniforms;
    flightNow.active = true;
    flightNow.velocity.set(0, 0, 0);
    flightNow.rush = flightNow.push = flightNow.warp = 0;
    life.update(lifeFrame());
    expect(streaks.visible).toBe(false);
    // A cruise along the look (the frame's camera looks down -z): the point ahead in the middle, running out.
    flightNow.velocity.set(0, 0, -900);
    flightNow.rush = 0.8;
    life.update(lifeFrame());
    expect(streaks.visible).toBe(true);
    expect(u['uDir']!.value).toBe(1);
    expect(Math.hypot(...(u['uFocus']!.value as { toArray(): number[] }).toArray())).toBeLessThan(0.05);
    // Backwards: the point behind, the lines running in.
    flightNow.velocity.set(0, 0, 900);
    life.update(lifeFrame());
    expect(u['uDir']!.value).toBe(-1);
    // The jump.
    flightNow.warp = 1;
    life.update(lifeFrame());
    expect(u['uWarp']!.value).toBe(1);
    // Landed: none.
    flightNow.active = false;
    life.update(lifeFrame());
    expect(streaks.visible).toBe(false);
    flightNow.velocity.set(0, 0, 0);
    flightNow.rush = flightNow.push = flightNow.warp = 0;
    life.dispose();
  });
});

describe('the sky shaders', () => {
  it('never take pow of a base that can be negative (one NaN pixel, spread by the bloom, emptied the whole frame)', () => {
    // Bases known to be at or over zero: held by max/abs/clamp, or 1 + g^2 - 2gc
    // (Cornette-Shanks, at least (1 - g)^2), or an fbm (a sum of noise in 0..1).
    const safe = /^(max\(|abs\(|clamp\(|1\.0 \+ g \* g - 2\.0 \* g \* c|clouds\b)/;
    const unsafe: string[] = [];
    for (const file of ['src/render/planet/skyLife.ts', 'src/render/planet/space.ts', 'src/render/planet/air.ts']) {
      const source = readFileSync(file, 'utf8').split('\n');
      source.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        for (const m of line.matchAll(/(?<![.\w])pow\(\s*/g)) {
          const rest = line.slice((m.index ?? 0) + m[0].length);
          if (!safe.test(rest)) unsafe.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(unsafe).toEqual([]);
  });
});
