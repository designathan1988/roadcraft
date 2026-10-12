import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { natureNoise3 } from '../natureNoise';

/**
 * THE ASTEROIDS: one field of rocks out in space to fly to (the player's
 * brief, 2026-10-10, section 11), far from the planet and off the way to the
 * moon, with wide emptiness round it.
 *
 *  - SHAPES: `SHAPES` rocks of their own, not one stone scaled - a sphere
 *    pushed in and out by three octaves of 3D noise, flattened along a
 *    random axis, its surface dented by craters (a bowl with a raised rim).
 *    Each shape is made twice, at two levels of detail, from the same
 *    function, so the far one is the near one's silhouette.
 *  - ONE DRAW A SHAPE AND LEVEL (three's InstancedMesh): every rock an
 *    instance; its slow spin turned in the vertex shader from an axis and a
 *    rate of its own (`aSpin`), so nothing is updated a frame on the CPU and
 *    no two rocks turn together.
 *  - LEVEL OF DETAIL BY SIZE ON SCREEN: a few times a second each rock is
 *    put in the near or the far mesh by its angular size, and rocks smaller
 *    than a pixel or two are not drawn at all.
 *  - LIT BY THE SUN like everything else (the scene's sun light, its
 *    direction the drawn sun's), dark rock with a little colour of its own.
 *
 * - THE FIELD MOVES: a swarm in orbit round the planet, not a block hung in
 *   space (the player, 2026-10-11: "em bloco parado"). Each rock goes round
 *   at its own distance's Keplerian rate (Kepler's third law, the rate as
 *   a^-3/2: the inner rocks overtake the outer, the swarm shears), and about
 *   its place in that orbit on the bounded relative orbit of the
 *   Clohessy-Wiltshire equations - an ellipse twice as long along the orbit
 *   as across it, one turn an orbit. Worked out in the vertex shader as a
 *   shift of the rock (its normals untouched, nothing on the CPU a frame),
 *   and by the same formula on the CPU for the levels, the flight's
 *   collisions and the field's place on the panel (`rockAt`).
 *
 * The field is written in the planet's own frame and set down with the
 * planet each frame (`planetMotion`), as the moon is.
 */

/** Rocks in the field, distinct shapes, and the field's place and reach (the planet's frame, in its radii). */
const COUNT = 1400;
const SHAPES = 8;
const FIELD_DIR = new Vector3(-0.55, 0.32, -0.77).normalize();
const FIELD_DISTANCE = 26;
const FIELD_REACH = 3.2;
/** Rocks' sizes: radius from `SMALLEST` to `LARGEST` world units, most small (a power law). */
const SMALLEST = 25;
const LARGEST = 2600;
/** Angular radius (rad) over which a rock is drawn in full; under `TINY` not drawn. */
const NEAR_ANGLE = 0.004;
const TINY = 0.0006;
/** How often the rocks are sorted into their levels, s. */
const SORT_EVERY = 0.25;
/**
 * One turn of the field's middle round the planet, real seconds: some
 * hundreds of metres a second along its orbit, a few metres a second
 * between neighbours - a swarm seen drifting by from among its rocks.
 */
const FIELD_PERIOD = 1200;
/** The field's middle's rate round the planet, rad/s. */
const FIELD_RATE = (Math.PI * 2) / FIELD_PERIOD;
/** A rock's relative orbit (Clohessy-Wiltshire): its radial half-axis, world units. */
const DRIFT_LEAST = 300;
const DRIFT_MOST = 4000;
/** The field's orbit's axis (the planet's frame): square to the field's direction and tilted off the equator. */
const FIELD_AXIS = new Vector3(0.18, 0.12, 1).cross(FIELD_DIR).cross(FIELD_DIR).negate().normalize();


export interface AsteroidRock {
  /** Its centre in three's space (as last sorted) and radius. */
  readonly centre: Vector3;
  readonly radius: number;
}

export interface Asteroids {
  readonly group: Group;
  /** Sets the field down with the planet and sorts the rocks by their size on screen. */
  update(camera: Camera, motion: Readonly<Matrix4>, seconds: number): void;
  /** The rocks nearest a point (three's space), at most `most`, for the flight's collisions. */
  nearest(at: Vector3, most: number): readonly AsteroidRock[];
  /**
   * The swarm's own motion at a point (three's space, world units a second),
   * into `out`: the Keplerian orbit there, full within the field and fading
   * to nothing half its reach out. A ship among the rocks orbits with them,
   * as a spacecraft parked in the swarm does (`flight.ts`).
   */
  driftAt(at: Vector3, out: Vector3): Vector3;
  /** The field's centre (three's space) and reach, for the flight's panel. */
  readonly centre: Vector3;
  readonly reach: number;
  dispose(): void;
}

/** A deterministic 0..1 sequence. */
function sequence(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One rock's shape at a level of detail: the same function at either. */
export function rockGeometry(shape: number, detail: number): BufferGeometry {
  const random = sequence(9173 + shape * 131);
  const base = mergeVertices(new IcosahedronGeometry(1, detail));
  const position = base.getAttribute('position') as BufferAttribute;
  const squash = new Vector3(0.65 + random() * 0.35, 0.55 + random() * 0.35, 0.8 + random() * 0.2);
  const craters = Array.from({ length: 7 }, () => ({
    dir: new Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize(),
    size: 0.18 + random() * 0.32,
  }));
  const colours = new Float32Array(position.count * 3);
  const tint = new Color().setHSL(0.07 + random() * 0.05, 0.12 + random() * 0.1, 0.26 + random() * 0.08);
  const p = new Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).normalize();
    let r = 1
      + (natureNoise3(p.x * 4, p.y * 4, p.z * 4, 1, shape * 7 + 1) - 0.5) * 0.55
      + (natureNoise3(p.x * 9, p.y * 9, p.z * 9, 1, shape * 7 + 2) - 0.5) * 0.18
      + (natureNoise3(p.x * 21, p.y * 21, p.z * 21, 1, shape * 7 + 3) - 0.5) * 0.06;
    let shade = 1;
    for (const c of craters) {
      const d = Math.acos(Math.min(1, p.dot(c.dir))) / c.size;
      if (d < 1) { r -= (1 - d * d) * 0.09 * c.size * 3; shade -= (1 - d) * 0.18; }
      else if (d < 1.35) r += Math.sin((d - 1) / 0.35 * Math.PI) * 0.025 * c.size * 3;
    }
    position.setXYZ(i, p.x * r * squash.x, p.y * r * squash.y, p.z * r * squash.z);
    const grain = 0.85 + natureNoise3(p.x * 30, p.y * 30, p.z * 30, 1, shape * 7 + 4) * 0.3;
    colours[i * 3] = tint.r * shade * grain;
    colours[i * 3 + 1] = tint.g * shade * grain;
    colours[i * 3 + 2] = tint.b * shade * grain;
  }
  base.setAttribute('color', new BufferAttribute(colours, 3));
  base.computeVertexNormals();
  base.computeBoundingSphere();
  return base;
}

/** The rock material: lit rock, not bent round the planet, each instance spun in the vertex shader. */
function rockMaterial(time: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: false });
  material.defines = { PLANET_SKIP: '' };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uRockTime'] = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aSpin;
        // The rock's orbit: its rate round the planet, its relative orbit's half-axis, phase and tilt.
        attribute vec4 aOrbit;
        uniform float uRockTime;
        const vec3 ROCK_AXIS = vec3(${FIELD_AXIS.x.toFixed(6)}, ${FIELD_AXIS.y.toFixed(6)}, ${FIELD_AXIS.z.toFixed(6)});
        vec3 rockSpin(vec3 v) {
          float a = aSpin.w * uRockTime;
          vec3 k = aSpin.xyz;
          return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a));
        }
        // \`rockAt\`: where the rock written at c (the planet's frame) has gone by now.
        vec3 rockOrbit(vec3 c) {
          float a = aOrbit.x * uRockTime;
          vec3 k = ROCK_AXIS;
          vec3 p = c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
          vec3 radial = normalize(p - k * dot(k, p));
          vec3 along = cross(k, radial);
          float e = aOrbit.x * uRockTime + aOrbit.z;
          return p + radial * (aOrbit.y * cos(e)) - along * (2.0 * aOrbit.y * sin(e)) + k * (aOrbit.w * aOrbit.y * cos(e + 1.3));
        }`)
      .replace('#include <project_vertex>', `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          // The whole rock shifted with its centre's orbit (its normals stand).
          mvPosition.xyz += rockOrbit(instanceMatrix[3].xyz) - instanceMatrix[3].xyz;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = rockSpin(objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = rockSpin(transformed);`);
  };
  material.customProgramCacheKey = () => 'asteroid-rock-orbit';
  return material;
}

export function createAsteroids(): Asteroids {
  const group = new Group();
  group.name = 'space-asteroids';
  group.matrixAutoUpdate = false;
  group.userData = { planetSkip: true };
  const time = { value: 0 };
  const material = rockMaterial(time);
  const random = sequence(4421);

  // The rocks: where (the planet's frame), how big, which shape, how they turn.
  const centres = new Float32Array(COUNT * 3);
  const radii = new Float32Array(COUNT);
  const shapes = new Uint8Array(COUNT);
  const turns = new Float32Array(COUNT * 4);
  const spins = new Float32Array(COUNT * 4);
  /** Per rock: its rate round the planet (rad/s), its relative orbit's half-axis, its phase, its tilt out of the plane. */
  const orbits = new Float32Array(COUNT * 4);
  const fieldCentre = FIELD_DIR.clone().multiplyScalar(FIELD_DISTANCE * PLANET_RADIUS);
  const reach = FIELD_REACH * PLANET_RADIUS;
  const q = new Quaternion();
  const axis = new Vector3();
  for (let i = 0; i < COUNT; i++) {
    // A flattened cloud, denser to its middle, with a few clumps.
    const u = random(), v = random(), w = random();
    const rr = reach * Math.pow(u, 0.6);
    const th = v * Math.PI * 2, ph = Math.acos(2 * w - 1);
    centres[i * 3] = fieldCentre.x + rr * Math.sin(ph) * Math.cos(th);
    centres[i * 3 + 1] = fieldCentre.y + rr * Math.cos(ph) * 0.28;
    centres[i * 3 + 2] = fieldCentre.z + rr * Math.sin(ph) * Math.sin(th);
    radii[i] = SMALLEST * Math.pow(LARGEST / SMALLEST, Math.pow(random(), 3.2));
    shapes[i] = Math.floor(random() * SHAPES);
    axis.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    q.setFromAxisAngle(axis, random() * Math.PI * 2);
    turns[i * 4] = q.x; turns[i * 4 + 1] = q.y; turns[i * 4 + 2] = q.z; turns[i * 4 + 3] = q.w;
    axis.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    // Slow: a turn in some minutes to an hour, smaller rocks faster.
    spins[i * 4] = axis.x; spins[i * 4 + 1] = axis.y; spins[i * 4 + 2] = axis.z;
    spins[i * 4 + 3] = (0.006 + random() * 0.04) * Math.sqrt(SMALLEST * 10 / radii[i]!) * (random() < 0.5 ? -1 : 1);
    // Kepler: the rate as the distance to the -3/2; the relative orbit's size and phase its own.
    const distance = Math.hypot(centres[i * 3]!, centres[i * 3 + 1]!, centres[i * 3 + 2]!);
    orbits[i * 4] = FIELD_RATE * Math.pow(distance / (FIELD_DISTANCE * PLANET_RADIUS), -1.5);
    orbits[i * 4 + 1] = DRIFT_LEAST + (DRIFT_MOST - DRIFT_LEAST) * random() * random();
    orbits[i * 4 + 2] = random() * Math.PI * 2;
    orbits[i * 4 + 3] = random() * 1.2 - 0.6;
  }
  const perShape = new Uint16Array(SHAPES);
  for (let i = 0; i < COUNT; i++) perShape[shapes[i]!]!++;

  // A near and a far mesh a shape, each able to hold all of that shape's rocks.
  const levels = [3, 1].map((detail) => Array.from({ length: SHAPES }, (_, shape) => {
    const geometry = rockGeometry(shape, detail);
    const capacity = Math.max(1, perShape[shape]!);
    const spin = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    spin.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aSpin', spin);
    const orbit = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    orbit.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aOrbit', orbit);
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = { planetSkip: true };
    group.add(mesh);
    return { mesh, spin, orbit };
  }));

  const world = new Vector3();
  const eye = new Vector3();
  const placed = new Matrix4();
  const scale = new Vector3();
  const rockQ = new Quaternion();
  const worldCentres = new Float32Array(COUNT * 3);
  let sinceSort = SORT_EVERY;
  const centre = new Vector3();
  const nearOut: { centre: Vector3; radius: number; d: number }[] = Array.from({ length: 8 }, () => ({ centre: new Vector3(), radius: 0, d: 0 }));
  const result: AsteroidRock[] = [];

  const ax = FIELD_AXIS;
  const radial = new Vector3(), along = new Vector3();
  const inverse = new Matrix4(), local = new Vector3(), orbitCentre = new Vector3(), turn = new Matrix3();
  const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /** Where rock `i` has gone by now (the planet's frame), into `out`: the shader's \`rockOrbit\`. */
  const rockAt = (i: number, out: Vector3): Vector3 => {
    const cx = centres[i * 3]!, cy = centres[i * 3 + 1]!, cz = centres[i * 3 + 2]!;
    const a = orbits[i * 4]! * time.value;
    const ca = Math.cos(a), sa = Math.sin(a), kd = ax.x * cx + ax.y * cy + ax.z * cz;
    out.set(
      cx * ca + (ax.y * cz - ax.z * cy) * sa + ax.x * kd * (1 - ca),
      cy * ca + (ax.z * cx - ax.x * cz) * sa + ax.y * kd * (1 - ca),
      cz * ca + (ax.x * cy - ax.y * cx) * sa + ax.z * kd * (1 - ca),
    );
    const kp = ax.dot(out);
    radial.copy(out).addScaledVector(ax, -kp).normalize();
    along.crossVectors(ax, radial);
    const e = a + orbits[i * 4 + 2]!, h = orbits[i * 4 + 1]!;
    return out.addScaledVector(radial, h * Math.cos(e)).addScaledVector(along, -2 * h * Math.sin(e)).addScaledVector(ax, orbits[i * 4 + 3]! * h * Math.cos(e + 1.3));
  };

  const sort = (camera: Camera): void => {
    eye.setFromMatrixPosition(camera.matrixWorld);
    for (const level of levels) for (const { mesh } of level) mesh.count = 0;
    const m = group.matrix;
    for (let i = 0; i < COUNT; i++) {
      rockAt(i, world).applyMatrix4(m);
      const angle = radii[i]! / Math.max(1, world.distanceTo(eye));
      if (angle < TINY) continue;
      const { mesh, spin, orbit } = levels[angle > NEAR_ANGLE ? 0 : 1]![shapes[i]!]!;
      const k = mesh.count++;
      rockQ.set(turns[i * 4]!, turns[i * 4 + 1]!, turns[i * 4 + 2]!, turns[i * 4 + 3]!);
      const r = radii[i]!;
      placed.compose(world.set(centres[i * 3]!, centres[i * 3 + 1]!, centres[i * 3 + 2]!), rockQ, scale.set(r, r, r));
      mesh.setMatrixAt(k, placed);
      spin.setXYZW(k, spins[i * 4]!, spins[i * 4 + 1]!, spins[i * 4 + 2]!, spins[i * 4 + 3]!);
      orbit.setXYZW(k, orbits[i * 4]!, orbits[i * 4 + 1]!, orbits[i * 4 + 2]!, orbits[i * 4 + 3]!);
    }
    for (const level of levels) for (const { mesh, spin, orbit } of level) {
      mesh.instanceMatrix.needsUpdate = true;
      spin.needsUpdate = true;
      orbit.needsUpdate = true;
    }
  };

  return {
    group,
    centre,
    reach,
    update(camera, motion, seconds) {
      time.value += seconds;
      group.matrix.copy(motion);
      group.matrixWorldNeedsUpdate = true;
      // The field's middle where its orbit has carried it.
      const a = FIELD_RATE * time.value;
      centre.copy(fieldCentre).applyAxisAngle(FIELD_AXIS, a).applyMatrix4(motion);
      sinceSort += seconds;
      // Sorted a few times a second, and at once when the eye moved far for the field's scale.
      eye.setFromMatrixPosition(camera.matrixWorld);
      if (sinceSort >= SORT_EVERY) { sinceSort = 0; sort(camera); }
    },
    driftAt(at, out) {
      // Back to the planet's frame (the motion is rigid: its rotation's transpose).
      inverse.copy(group.matrix).invert();
      local.copy(at).applyMatrix4(inverse);
      const fade = 1 - smoothstep(reach, reach * 1.5, local.distanceTo(orbitCentre.copy(fieldCentre).applyAxisAngle(FIELD_AXIS, FIELD_RATE * time.value)));
      if (fade <= 0) return out.set(0, 0, 0);
      // The orbit's velocity there: its rate (Kepler, as the rocks') times the axis across the point.
      const rate = FIELD_RATE * Math.pow(local.length() / (FIELD_DISTANCE * PLANET_RADIUS), -1.5) * fade;
      return out.crossVectors(FIELD_AXIS, local).multiplyScalar(rate).applyMatrix3(turn.setFromMatrix4(group.matrix));
    },
    nearest(at, most) {
      // The few nearest by surface distance (a short insertion list, no
      // allocation), where the rocks are NOW: they move hundreds of metres
      // a second, and their places at the last sort were far behind them.
      const n = Math.min(most, nearOut.length);
      let filled = 0;
      for (let i = 0; i < COUNT; i++) {
        rockAt(i, world).applyMatrix4(group.matrix);
        worldCentres[i * 3] = world.x; worldCentres[i * 3 + 1] = world.y; worldCentres[i * 3 + 2] = world.z;
        const dx = worldCentres[i * 3]! - at.x, dy = worldCentres[i * 3 + 1]! - at.y, dz = worldCentres[i * 3 + 2]! - at.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - radii[i]!;
        if (d > radii[i]! * 6 + 400) continue;
        let k = filled < n ? filled++ : n;
        if (k === n && d >= nearOut[n - 1]!.d) continue;
        if (k === n) k = n - 1;
        while (k > 0 && nearOut[k - 1]!.d > d) {
          const a = nearOut[k - 1]!, b = nearOut[k]!;
          b.centre.copy(a.centre); b.radius = a.radius; b.d = a.d;
          k--;
        }
        const slot = nearOut[k]!;
        slot.centre.set(worldCentres[i * 3]!, worldCentres[i * 3 + 1]!, worldCentres[i * 3 + 2]!);
        slot.radius = radii[i]! * 0.82;
        slot.d = d;
      }
      result.length = 0;
      for (let k = 0; k < filled; k++) result.push(nearOut[k]!);
      return result;
    },
    dispose() {
      for (const level of levels) for (const { mesh } of level) { mesh.geometry.dispose(); mesh.dispose(); }
      material.dispose();
    },
  };
}
