import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';

import { TUNED_UNIT, m } from '@world/units';
import { pullTowardEye } from './depthConvention';
import type { Exhaust } from './exhaust';

/** Explosions, and what they throw */

type DebrisKind = 'asphalt' | 'concrete' | 'earth' | 'brick' | 'wood' | 'metal' | 'glass' | 'char' | 'leaf' | 'flesh';

const COLORS: Readonly<Record<DebrisKind, number>> = {
  asphalt: 0x2b2b2d, concrete: 0x9a968e, earth: 0x5b4632, brick: 0x8a4a35, wood: 0x6b4a2e,
  metal: 0x3c3f44, glass: 0x9fb8c4, char: 0x1c1a19, leaf: 0x3d6b2a, flesh: 0x6e0d10,
};

interface DebrisSpec {
  /** `car`: a car's shell (bonnet, windscreen, roof, boot), length x height x width. */
  /** `slab`: a broken plate of the ground, jagged at its edges (unit size, thin along y). */
  /** `mesh`: a geometry of its own (`geometry`, world units about its centre): a vehicle's own burnt-out body. */
  readonly shape: 'box' | 'cylinder' | 'car' | 'slab' | 'mesh';
  readonly kind: DebrisKind;
  readonly geometry?: BufferGeometry;
  /** World position of the centre (three's frame: y up). */
  readonly at: Vector3;
  /** Box: width, height, depth. Cylinder: radius, length, radius. */
  readonly size: Vector3;
  readonly turn?: Quaternion;
  readonly velocity: Vector3;
  readonly spin?: Vector3;
  /** Seconds of fire on it (a burning wreck), 0 for none. */
  readonly burn?: number;
  /** Laid where it is and left there (a heaved slab of the ground), never moved. */
  readonly still?: boolean;
  /** Colour over the kind's. */
  readonly color?: number;
}

interface BlastWorld {
  groundAt(x: number, y: number): number;
}

export interface Blast {
  readonly group: Group;
  /** The explosion itself at world (x, y), height z: `radius` its reach; `ground` what it tears up. */
  explode(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth' | 'building'): void;
  /** A crater (a hole and its broken rim) and the scorch round it. */
  crater(x: number, y: number, z: number, radius: number, ground: 'road' | 'earth'): void;
  debris(spec: DebrisSpec): void;
  /** A wire torn loose: pinned at `from` (world, three's frame), its loose end at `to`, thrown by `kick`. */
  wire(from: Vector3, to: Vector3, kick: Vector3): void;
  /** An electric discharge at a point, repeated for a while (a broken line on the ground). */
  arc(at: Vector3, seconds: number): void;
  /** How hard the camera shakes now (world units). */
  shake(): number;
  /** A fire that keeps burning at world (x, y), height z, `size` across, for `seconds`: flames and a black column. */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Soot and ash laid on the ground at world (x, y): the street left dirty by the blast, for good. */
  soot(x: number, y: number, z: number, radius: number): void;
  /** A broken hydrant at world (x, y): a jet of water for `seconds` (`GEYSER_SECONDS` if not given), dying down at its end. */
  geyser(x: number, y: number, z: number, seconds?: number): void;
  /** A burst pipe: a thin spurt of water for a moment, not a hydrant's jet. */
  leak(x: number, y: number, z: number, seconds: number): void;
  /** Whether anything is still moving, burning or flashing. */
  active(): boolean;
  /** Everything gone: debris, wrecks, craters, soot, fires, wires, jets (the weapons lab's clean slate). */
  clear(): void;
  update(dt: number, world: BlastWorld): void;
  dispose(): void;
}

const MAX_PIECES = 1400;
const MAX_CRATERS = 60;
/** Soot blots kept on the ground at once (oldest go first). */
const MAX_SOOT = 600;
const MAX_WIRES = 40;
const WIRE_POINTS = 12;
const GRAVITY = m(9.8);
/** DO NOT make it endless: it sprayed 110 particles a second and kept `active()` - every frame drawn */
const GEYSER_SECONDS = 45, GEYSER_FADE = 6;

interface Piece {
  readonly mesh: 'box' | 'cylinder' | 'car' | 'slab' | 'mesh';
  /** A `mesh` piece's own object. */
  readonly object?: Mesh;
  readonly p: Vector3;
  readonly v: Vector3;
  readonly q: Quaternion;
  readonly w: Vector3;
  readonly size: Vector3;
  readonly corners: Vector3[];
  readonly color: Color;
  /** Inverse of the (round) inertia, per unit mass. */
  readonly invI: number;
  burn: number;
  rest: number;
  asleep: boolean;
  /** Never moved, never culled for room (a heaved slab of the ground). */
  still?: boolean;
}

interface Rope { p: Vector3[]; o: Vector3[]; pin: Vector3; seg: number; sparks: number; age: number }

interface Crater { x: number; y: number; z: number; r: number; road: boolean; age: number; angle: number }

function craterTexture(road: boolean): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = road ? 7 : 13;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const mid = size / 2;
  // Scorch: soot spreading out, ragged.
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2, r = size * (0.15 + rnd() * 0.3);
    const x = mid + Math.cos(a) * r * 0.6, y = mid + Math.sin(a) * r * 0.6, rad = size * (0.08 + rnd() * 0.14);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(12, 10, 9, 0.55)');
    grad.addColorStop(1, 'rgba(12, 10, 9, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  // The hole: dark earth, deeper at the middle, a lighter broken lip.
  const hole = size * 0.26;
  const pts: [number, number][] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2, r = hole * (0.82 + rnd() * 0.3);
    pts.push([mid + Math.cos(a) * r, mid + Math.sin(a) * r]);
  }
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, hole * 1.1);
  grad.addColorStop(0, road ? 'rgba(28, 22, 17, 1)' : 'rgba(34, 25, 17, 1)');
  grad.addColorStop(0.7, road ? 'rgba(58, 46, 36, 1)' : 'rgba(70, 52, 34, 1)');
  grad.addColorStop(1, road ? 'rgba(92, 86, 80, 1)' : 'rgba(96, 74, 50, 1)');
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = road ? 'rgba(120, 116, 110, 0.9)' : 'rgba(110, 86, 60, 0.9)';
  g.stroke();
  // Clods and grit in and round it.
  for (let i = 0; i < 160; i++) {
    const a = rnd() * Math.PI * 2, r = hole * (0.2 + rnd() * 1.6);
    const s = 1 + rnd() * 3;
    const shade = road ? 40 + rnd() * 70 : 50 + rnd() * 50;
    g.fillStyle = road ? `rgba(${shade},${shade},${shade + 4},0.9)` : `rgba(${shade + 30},${shade + 12},${shade - 10},0.9)`;
    g.fillRect(mid + Math.cos(a) * r, mid + Math.sin(a) * r, s, s);
  }
  // Cracks running out through the paving.
  if (road) {
    g.strokeStyle = 'rgba(14, 12, 12, 0.85)';
    for (let i = 0; i < 11; i++) {
      let a = rnd() * Math.PI * 2, r = hole * 0.9;
      let x = mid + Math.cos(a) * r, y = mid + Math.sin(a) * r;
      g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(x, y);
      const length = size * (0.12 + rnd() * 0.22);
      for (let s = 0; s < 8; s++) {
        a += (rnd() - 0.5) * 0.7;
        r = length / 8;
        x += Math.cos(a) * r; y += Math.sin(a) * r;
        g.lineTo(x, y);
        g.lineWidth = Math.max(0.6, 2.2 - s * 0.25);
        if (rnd() < 0.25) {
          const b = a + (rnd() < 0.5 ? 0.8 : -0.8);
          g.moveTo(x, y); g.lineTo(x + Math.cos(b) * r * 2, y + Math.sin(b) * r * 2); g.moveTo(x, y);
        }
      }
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** `light`: the flash, made by the renderer and in the scene since it opened (`PlayEffectsContext.lights`). */
export function createBlast(exhaust: Exhaust, light: PointLight): Blast {
  const group = new Group();
  group.name = 'blast';
  const debrisMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0.05 });
  const boxes = new InstancedMesh(new BoxGeometry(1, 1, 1), debrisMaterial, MAX_PIECES);
  const cylinders = new InstancedMesh(new CylinderGeometry(1, 1, 1, 9), debrisMaterial, MAX_PIECES);
  // A car's side, extruded across: a unit box's worth, centred, x along the car.
  const side = new Shape();
  const profile: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.12], [0.44, 0.0], [0.2, 0.05], [0.08, 0.48], [-0.28, 0.5], [-0.42, 0.08], [-0.5, 0.02]];
  profile.forEach(([x, y], i) => (i ? side.lineTo(x, y) : side.moveTo(x, y)));
  side.closePath();
  const shellGeometry = new ExtrudeGeometry(side, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  const shells = new InstancedMesh(shellGeometry, debrisMaterial, 80);
  // A broken slab of road or footway: an irregular outline with notches and a torn edge, extruded thin
  const jag = new Shape();
  const corners = 11;
  for (let k = 0; k < corners; k++) {
    const a = (k / corners) * Math.PI * 2;
    const r = 0.36 + 0.14 * Math.sin(k * 2.7 + 1.3) + (k % 3 === 0 ? -0.1 : 0.04);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (k) jag.lineTo(x, y); else jag.moveTo(x, y);
  }
  jag.closePath();
  const slabGeometry = new ExtrudeGeometry(jag, { depth: 1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.04, bevelSegments: 1 })
    .translate(0, 0, -0.5).rotateX(-Math.PI / 2);
  const slabs = new InstancedMesh(slabGeometry, debrisMaterial, MAX_PIECES);
  for (const mesh of [boxes, cylinders, shells, slabs]) {
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Instance colours from the first frame, so the program never changes variant.
    mesh.setColorAt(0, new Color(1, 1, 1));
    mesh.visible = false;
    group.add(mesh);
  }
  const craterGeometry = new CircleGeometry(0.5, 28).rotateX(-Math.PI / 2);
  const craterMaterials = [craterTexture(true), craterTexture(false)].map((map) => new MeshStandardMaterial({
    map, transparent: true, depthWrite: false, roughness: 1,
  }));
  for (const material of craterMaterials) pullTowardEye(material, 4, 4);
  // Soot: a soft dark blot, many of them, kept (the street stays dirty).
  const sootMap = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    for (let k = 0; k < 26; k++) {
      const x = 64 + (Math.random() - 0.5) * 70, y = 64 + (Math.random() - 0.5) * 70, r = 10 + Math.random() * 34;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(20,17,14,${0.25 + Math.random() * 0.25})`); grad.addColorStop(1, 'rgba(20,17,14,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    }
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  })();
  const soot = new MeshStandardMaterial({ map: sootMap, transparent: true, depthWrite: false, roughness: 1 });
  pullTowardEye(soot, 3, 3);
  craterMaterials.push(soot);
  const craterMeshes = craterMaterials.map((material, i) => {
    if (i === 2) {
      const mesh = new InstancedMesh(craterGeometry, material, MAX_SOOT);
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.receiveShadow = true; mesh.visible = false;
      group.add(mesh);
      return mesh;
    }
    const mesh = new InstancedMesh(craterGeometry, material, MAX_CRATERS);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.receiveShadow = true;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });
  // The shockwave: a bright ring racing out over the ground.
  const ringMaterial = new MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
  const ring = new Mesh(new RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2), ringMaterial);
  ring.visible = false;
  ring.renderOrder = 6;
  group.add(ring);
  // The flash: one light, reused, and its colour (white-orange for a blast, blue-white for an arc).
  light.castShadow = false;
  const wireGeometry = new BufferGeometry();
  const wirePositions = new Float32Array(MAX_WIRES * (WIRE_POINTS - 1) * 2 * 3);
  wireGeometry.setAttribute('position', new BufferAttribute(wirePositions, 3));
  const wires = new LineSegments(wireGeometry, new LineBasicMaterial({ color: 0x141414 }));
  wires.frustumCulled = false;
  wires.visible = false;
  group.add(wires);

  const pieces: Piece[] = [];
  const ropes: Rope[] = [];
  const craters: Crater[] = [];
  const soots: Crater[] = [];
  const geysers: { x: number; y: number; z: number; carry: number; until: number; weak?: boolean }[] = [];
  let sootDirty = false;
  const fires: { at: Vector3; until: number; rate: number; carry: number; piece?: Piece; size?: number; smoke?: number }[] = [];
  const arcs: { at: Vector3; until: number; next: number }[] = [];
  let time = 0;
  let flash = 0, flashLife = 0.15;
  let ringAge = Infinity, ringReach = 0, ringAt = new Vector3();
  let shakeAmp = 0;
  let clock = 0;
  let drawnPieces = -1;
  const o = new Object3D();

  /** A burnt-out vehicle (as GTA leaves them) */
  const carcassMaterial = (paint: number): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({ roughness: 0.92, metalness: 0.25, side: DoubleSide });
    material.onBeforeCompile = (shader) => {
      shader.uniforms['uPaint'] = { value: new Color(paint) };
      shader.vertexShader = 'varying vec3 vCarcass;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarcass = position;');
      shader.fragmentShader = `uniform vec3 uPaint; varying vec3 vCarcass;
float carcassHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float carcassNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(carcassHash(i), carcassHash(i + vec3(1, 0, 0)), f.x), mix(carcassHash(i + vec3(0, 1, 0)), carcassHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(carcassHash(i + vec3(0, 0, 1)), carcassHash(i + vec3(1, 0, 1)), f.x), mix(carcassHash(i + vec3(0, 1, 1)), carcassHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
${shader.fragmentShader}`.replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 q = vCarcass * ${(1 / m(0.22)).toFixed(4)};
  // Two octaves each: fine-grained burns, not blotches.
  float n1 = 0.65 * carcassNoise(q) + 0.35 * carcassNoise(q * 3.1 + 7.0);
  float n2 = 0.6 * carcassNoise(q * 2.3 + 13.0) + 0.4 * carcassNoise(q * 6.0 + 29.0);
  float n3 = carcassNoise(q * 0.5 + 41.0);
  vec3 soot = vec3(0.03, 0.028, 0.026);
  vec3 ash = vec3(0.2, 0.19, 0.18);
  vec3 rust = vec3(0.24, 0.12, 0.065);
  vec3 c = mix(soot, ash, smoothstep(0.4, 0.8, n1) * 0.55);
  c = mix(c, rust, smoothstep(0.62, 0.86, n2) * 0.55);
  // A trace of the paint, scorched, low down on the sides where it burnt least.
  float low = 1.0 - smoothstep(${m(0.3).toFixed(3)}, ${m(0.9).toFixed(3)}, vCarcass.y + ${m(0.6).toFixed(3)});
  c = mix(c, uPaint * 0.22, smoothstep(0.6, 0.85, n3) * low * 0.6);
  diffuseColor.rgb = c;
}`);
    };
    material.customProgramCacheKey = () => 'vehicle-carcass';
    return material;
  };

  const piece = (spec: DebrisSpec): void => {
    const s = spec.size;
    let object: Mesh | undefined;
    if (spec.shape === 'mesh' && spec.geometry) {
      // Burnt, or a machine merely knocked down in its own paint.
      object = new Mesh(spec.geometry, spec.kind === 'char' ? carcassMaterial(spec.color ?? 0x444444)
        : new MeshStandardMaterial({ color: spec.color ?? 0x666666, roughness: 0.45, metalness: 0.35, side: DoubleSide }));
      object.castShadow = true;
      object.receiveShadow = true;
      group.add(object);
    }
    const corners = spec.shape !== 'cylinder'
      ? [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new Vector3(x * s.x / 2, y * s.y / 2, z * s.z / 2))))
      : [-1, 1].flatMap((y) => [0, 1, 2, 3].map((k) => new Vector3(Math.cos(k * Math.PI / 2) * s.x, y * s.y / 2, Math.sin(k * Math.PI / 2) * s.z)));
    const extent = spec.shape !== 'cylinder' ? s.x * s.x + s.y * s.y + s.z * s.z : s.y * s.y + 3 * s.x * s.x;
    const body: Piece = {
      mesh: spec.shape, ...(object ? { object } : {}), p: spec.at.clone(), v: spec.velocity.clone(), q: spec.turn?.clone() ?? new Quaternion(),
      w: spec.spin?.clone() ?? new Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      size: s.clone(), corners, color: new Color(spec.color ?? COLORS[spec.kind]).multiplyScalar(0.85 + Math.random() * 0.3),
      invI: 12 / Math.max(1e-4, extent), burn: spec.burn ?? 0, rest: 0, asleep: spec.still === true, ...(spec.still ? { still: true } : {}),
    };
    pieces.push(body);
    if (body.burn > 0) fires.push({ at: body.p, until: time + body.burn, rate: 28, carry: 0, piece: body });
    if (pieces.length > MAX_PIECES) {
      const gone = pieces.splice(Math.max(0, pieces.findIndex((p) => p.asleep && p.burn <= 0 && !p.still && !p.object)), 1)[0];
      if (gone?.object) dropObject(gone.object);
    }
    // Not more than this many wrecks kept: the oldest goes.
    const wrecks = pieces.filter((p) => p.object);
    if (wrecks.length > 40) {
      const old = wrecks[0]!;
      pieces.splice(pieces.indexOf(old), 1);
      dropObject(old.object!);
    }
  };

  const dropObject = (object: Mesh): void => {
    group.remove(object);
    object.geometry.dispose();
    (object.material as MeshStandardMaterial).dispose();
  };

  /** One step of a rigid piece: gravity, then each corner below the ground struck with an impulse. */
  const stepPiece = (b: Piece, dt: number, world: BlastWorld): void => {
    b.v.y -= GRAVITY * dt;
    b.p.addScaledVector(b.v, dt);
    const angle = b.w.length() * dt;
    if (angle > 1e-6) b.q.premultiply(spinQ.setFromAxisAngle(tmp1.copy(b.w).normalize(), angle)).normalize();
    let touching = false;
    let deepest = 0;
    /** How far the lowest corner is above the ground (negative: into it). */
    let lowest = Infinity;
    for (const c of b.corners) {
      const r = tmp2.copy(c).applyQuaternion(b.q);
      const wp = tmp3.copy(b.p).add(r);
      const ground = world.groundAt(wp.x, -wp.z);
      const pen = ground - wp.y;
      lowest = Math.min(lowest, -pen);
      if (pen <= 0) continue;
      touching = true;
      deepest = Math.max(deepest, pen);
      // Velocity of the corner, and the impulse that stops it going in.
      const vp = tmp4.copy(b.w).cross(r).add(b.v);
      const vn = vp.y;
      if (vn < 0) {
        const rn = tmp5.set(-r.z, 0, r.x); // r x up
        const k = 1 + b.invI * (r.x * r.x + r.z * r.z);
        const j = (-(1 + 0.25) * vn) / k;
        b.v.y += j;
        b.w.addScaledVector(rn, b.invI * j);
        // Friction across the contact, at most a share of the push.
        const tx = vp.x, tz = vp.z;
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-6) {
          const f = Math.min(tl / k, 0.6 * j);
          const fx = (-tx / tl) * f, fz = (-tz / tl) * f;
          b.v.x += fx; b.v.z += fz;
          // r x f, f horizontal.
          b.w.x += b.invI * (r.y * fz);
          b.w.y += b.invI * (r.z * fx - r.x * fz);
          b.w.z += b.invI * (-r.y * fx);
        }
      }
    }
    if (deepest > 0) b.p.y += deepest;
    if (touching) { b.w.multiplyScalar(0.985); b.v.x *= 0.995; b.v.z *= 0.995; }
    // At rest as Box2D judges it: the speed of the body's farthest point
    const reach = Math.sqrt(b.corners.reduce((most, c) => Math.max(most, c.lengthSq()), 0));
    const slow = b.v.length() + b.w.length() * reach < m(0.15) + 0.55 * reach;
    const resting = touching || lowest < m(0.05);
    b.rest = resting && slow ? b.rest + dt : 0;
    if (b.rest > 0.6) { b.asleep = true; b.v.set(0, 0, 0); b.w.set(0, 0, 0); }
  };

  const stepRope = (rope: Rope, dt: number, world: BlastWorld): void => {
    rope.age += dt;
    const { p, o: old } = rope;
    for (let k = 0; k < p.length; k++) {
      const v = p[k]!, q = old[k]!;
      const vx = (v.x - q.x) * 0.99, vy = (v.y - q.y) * 0.99, vz = (v.z - q.z) * 0.99;
      q.copy(v);
      v.x += vx; v.y += vy - GRAVITY * dt * dt; v.z += vz;
    }
    for (let it = 0; it < 12; it++) {
      p[0]!.copy(rope.pin);
      for (let k = 1; k < p.length; k++) {
        const a = p[k - 1]!, b = p[k]!;
        const d = tmp1.subVectors(b, a);
        const l = d.length() || 1e-6;
        if (l <= rope.seg) continue;
        const diff = (l - rope.seg) / l;
        if (k === 1) b.addScaledVector(d, -diff);
        else { a.addScaledVector(d, diff * 0.5); b.addScaledVector(d, -diff * 0.5); }
      }
      for (let k = 1; k < p.length; k++) {
        const v = p[k]!;
        const g = world.groundAt(v.x, -v.z) + m(0.03);
        if (v.y < g) { v.y = g; old[k]!.x = v.x - (v.x - old[k]!.x) * 0.6; old[k]!.z = v.z - (v.z - old[k]!.z) * 0.6; }
      }
    }
    // The loose end live on the ground: sparks and blue flashes for a while.
    const end = p[p.length - 1]!;
    if (rope.age < rope.sparks && end.y < world.groundAt(end.x, -end.z) + m(0.3) && Math.random() < dt * 9) {
      exhaust.burst(end.x, -end.z, end.y + m(0.05), 10, 6, m(0.1), m(0.08), 0.5);
      if (Math.random() < 0.4) flashAt(end, 0x9fc8ff, 900, 0.08);
    }
  };

  const flashAt = (at: Vector3, color: number, power: number, life: number): void => {
    if (flash > power * 0.6 && light.color.getHex() !== color) return;
    light.position.copy(at);
    light.color.setHex(color);
    flash = Math.max(flash, power);
    flashLife = life;
  };

  return {
    group,
    explode(x, y, z, radius, ground) {
      const at = new Vector3(x, z, -y);
      // Flash and light.
      flashAt(at.clone().setY(z + m(2)), 0xffb060, 9000 + radius * 400, 0.35);
      // Fireball: flame puffs out and up, a column rising after it.
      exhaust.burst(x, y, z + m(0.8), 110, 5, radius * 0.45, m(2.6) + radius * 0.12, 1.1);
      exhaust.burst(x, y, z + m(2.5), 60, 5, radius * 0.25, m(3.2) + radius * 0.15, 1.6);
      fires.push({ at: at.clone().setY(z + m(0.5)), until: time + 1.5, rate: 90, carry: 0, size: radius * 0.35, smoke: 0.3 });
      // Then it burns on in the crater a while, under a column of black smoke.
      fires.push({ at: at.clone().setY(z + m(0.2)), until: time + 6 + Math.min(10, radius * 0.05), rate: 10, carry: 0, size: Math.min(m(3), radius * 0.08), smoke: 0.6 });
      // Smoke: dark, rising and spreading, then the dust of what was torn up.
      exhaust.burst(x, y, z + m(1.5), 80, 2, radius * 0.45, m(3.5), 7);
      exhaust.burst(x, y, z + m(5), 40, 2, radius * 0.35, m(4.5), 9);
      exhaust.burst(x, y, z + m(0.3), 40, ground === 'earth' ? 1 : 3, radius * 0.6, m(2.2), 6);
      // Sparks and grit flung out under gravity.
      exhaust.burst(x, y, z + m(0.5), 120, 6, m(0.5), m(0.1), 1.1);
      exhaust.burst(x, y, z + m(0.2), 90, 7, m(0.6), m(0.18), 1.4);
      // The shockwave and the shake.
      ringAt = new Vector3(x, z + m(0.15), -y);
      ringAge = 0;
      ringReach = radius * 2.4;
      shakeAmp = Math.max(shakeAmp, m(0.25) + radius * 0.04);
      // Shrapnel of what the ground was.
      const kinds: DebrisKind[] = ground === 'earth' ? ['earth', 'earth', 'earth', 'concrete'] : ground === 'road' ? ['asphalt', 'asphalt', 'concrete', 'earth'] : ['concrete', 'brick', 'glass', 'concrete'];
      const n = Math.round(24 + radius * 1.5);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const out = m(4 + Math.random() * 9);
        const s = m(0.08 + Math.random() * Math.random() * 0.45);
        piece({
          shape: 'box', kind: kinds[i % kinds.length]!,
          at: new Vector3(x + Math.cos(a) * radius * 0.2, z + m(0.3), -(y + Math.sin(a) * radius * 0.2)),
          size: new Vector3(s * (1 + Math.random()), s * (0.4 + Math.random() * 0.5), s * (1 + Math.random())),
          velocity: new Vector3(Math.cos(a) * out, m(5 + Math.random() * 10), -Math.sin(a) * out),
        });
      }
    },
    crater(x, y, z, radius, ground) {
      const road = ground === 'road';
      craters.push({ x, y, z, r: radius, road, age: 0, angle: Math.random() * Math.PI * 2 });
      if (craters.length > MAX_CRATERS) craters.shift();
      // The broken rim: slabs of the surface heaved up and tilted round the hole.
      const slabs = Math.round(8 + radius * 0.8);
      for (let i = 0; i < slabs; i++) {
        const a = (i / slabs) * Math.PI * 2 + Math.random() * 0.4;
        const r = radius * (0.32 + Math.random() * 0.12);
        const s = m(0.35 + Math.random() * 0.5) * (road ? 1 : 0.8);
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(a), 0, -Math.cos(a)), 0.4 + Math.random() * 0.6);
        piece({
          shape: 'box', kind: road ? (i % 3 === 0 ? 'concrete' : 'asphalt') : 'earth',
          at: new Vector3(x + Math.cos(a) * r, z + m(0.1), -(y + Math.sin(a) * r)),
          size: new Vector3(s, m(road ? 0.12 : 0.2), s * (0.6 + Math.random() * 0.5)),
          turn: tilt, velocity: new Vector3(Math.cos(a) * m(0.6), m(0.8), -Math.sin(a) * m(0.6)), spin: new Vector3(),
        });
      }
      // The ground heaved up in plates round it
      const already = pieces.filter((b) => b.still && Math.hypot(b.p.x - x, b.p.z + y) < radius * 1.4).length;
      const plates = already > 25 ? 0 : Math.round(10 + radius / m(1.6));
      for (let i = 0; i < Math.min(plates, 60); i++) {
        const a = Math.random() * Math.PI * 2;
        const r = radius * (0.4 + Math.sqrt(Math.random()) * 1.1);
        const w = m(1.2 + Math.random() * 2.6) * Math.min(2, 0.6 + radius / m(20));
        const d = w * (0.5 + Math.random() * 0.6);
        const thick = m(road ? 0.3 : 0.45);
        // Tipped about an axis across the way out, the inner edge sunk.
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(a), 0, -Math.cos(a)), 0.35 + Math.random() * 0.75)
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.random() * Math.PI));
        // Dirty: dust and earth over the asphalt or the concrete, each its own shade.
        const base = new Color(road ? (Math.random() < 0.35 ? COLORS.concrete : COLORS.asphalt) : COLORS.earth);
        const dirt = base.lerp(new Color(0x6e6357), 0.25 + Math.random() * 0.35).multiplyScalar(0.7 + Math.random() * 0.35);
        piece({
          shape: 'slab', kind: road ? 'asphalt' : 'earth', color: dirt.getHex(),
          at: new Vector3(x + Math.cos(a) * r, z + w * 0.18, -(y + Math.sin(a) * r)),
          size: new Vector3(w, thick, d), turn: tilt, velocity: new Vector3(0, 0, 0), spin: new Vector3(), still: true,
        });
        // Earth and grit thrown up round it.
        if (i % 3 === 0) piece({ shape: 'box', kind: 'earth', at: new Vector3(x + Math.cos(a) * r, z + m(0.2), -(y + Math.sin(a) * r)),
          size: new Vector3(m(0.3 + Math.random() * 0.4), m(0.2), m(0.3 + Math.random() * 0.4)), velocity: new Vector3(), spin: new Vector3(), still: true });
      }
    },
    debris: piece,
    wire(from, to, kick) {
      const p: Vector3[] = [], o: Vector3[] = [];
      for (let k = 0; k < WIRE_POINTS; k++) {
        const v = from.clone().lerp(to, k / (WIRE_POINTS - 1));
        p.push(v);
        o.push(v.clone().addScaledVector(kick, -(k / (WIRE_POINTS - 1)) / 60));
      }
      ropes.push({ p, o, pin: from.clone(), seg: from.distanceTo(to) / (WIRE_POINTS - 1) * 1.05, sparks: 5 + Math.random() * 6, age: 0 });
      if (ropes.length > MAX_WIRES) ropes.shift();
    },
    arc(at, seconds) {
      arcs.push({ at: at.clone(), until: time + seconds, next: time });
    },
    shake: () => shakeAmp,
    soot(x, y, z, radius) {
      soots.push({ x, y, z, r: radius, road: false, age: 1, angle: Math.random() * Math.PI * 2 });
      if (soots.length > MAX_SOOT) soots.shift();
      sootDirty = true;
    },
    leak(x, y, z, seconds) {
      geysers.push({ x, y, z, carry: 0, until: time + seconds, weak: true });
    },
    geyser(x, y, z, seconds) {
      const life = seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : GEYSER_SECONDS;
      geysers.push({ x, y, z, carry: 0, until: time + life });
      if (geysers.length > 40) geysers.shift();
    },
    burn(x, y, z, size, seconds) {
      fires.push({ at: new Vector3(x, z, -y), until: time + seconds, rate: Math.min(9, 4 + size / m(2)), carry: 0, size: Math.min(size, m(3)), smoke: 0.5 });
    },
    clear() {
      for (const p of pieces) if (p.object) dropObject(p.object);
      pieces.length = 0; ropes.length = 0; craters.length = 0; soots.length = 0; geysers.length = 0; fires.length = 0; arcs.length = 0;
      sootDirty = true;
      drawnPieces = -1;
      flash = 0; ringAge = Infinity; shakeAmp = 0;
    },
    active: () => geysers.length > 0 || flash > 1 || ringAge < 0.7 || fires.length > 0 || arcs.length > 0 || pieces.some((b) => !b.asleep) || ropes.some((r) => r.age < 12),
    update(dt, world) {
      const wall = Math.min(0.1, Math.max(0, dt));
      time += wall;
      clock += wall;
      const STEP = 1 / 60;
      while (clock >= STEP) {
        clock -= STEP;
        for (const b of pieces) if (!b.asleep) stepPiece(b, STEP, world);
        for (const r of ropes) stepRope(r, STEP, world);
      }
      // Fires: flame and smoke puffs from what burns.
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i]!;
        if (time > f.until) { fires.splice(i, 1); continue; }
        f.carry += f.rate * wall;
        const left = (f.until - time);
        while (f.carry >= 1) {
          f.carry -= 1;
          const at = f.piece ? f.piece.p : f.at;
          const big = f.piece ? Math.max(f.piece.size.x, f.piece.size.z) * 0.5 : f.size ?? m(1);
          const dying = Math.min(1, left / 3 + 0.3);
          exhaust.burst(at.x, -at.z, at.y + m(0.3), 1, 5, big, (m(1.1) + big * 0.4) * dying, 0.8);
          // A chimney of smoke off each fire
          if (Math.random() < 0.55) exhaust.burst(at.x, -at.z, at.y + m(1), 1, 2, m(0.4), m(1.3), 12);
          if (Math.random() < 0.6) exhaust.burst(at.x, -at.z, at.y + m(0.6), 1, 0, big * 0.4, m(1.5), 3.5);
        }
      }
      // Hydrants: a jet of water each, dying down at its end, then let go; and its puddle of spray.
      for (let i = geysers.length - 1; i >= 0; i--) {
        const g = geysers[i]!;
        if (time > g.until) { geysers.splice(i, 1); continue; }
        const strength = g.weak ? 1 : Math.min(1, (g.until - time) / GEYSER_FADE);
        g.carry += (g.weak ? 14 : 110) * strength * wall;
        while (g.carry >= 1) { g.carry -= 1; exhaust.burst(g.x, g.y, g.z + m(0.4), 1, 8, m(0.1), g.weak ? m(0.25) : m(0.8) * Math.max(0.25, strength), g.weak ? 1.2 : 4.2); }
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const a = arcs[i]!;
        if (time > a.until) { arcs.splice(i, 1); continue; }
        if (time >= a.next) {
          a.next = time + 0.08 + Math.random() * 0.5;
          exhaust.burst(a.at.x, -a.at.z, a.at.y, 18, 6, m(0.2), m(0.1), 0.6);
          flashAt(a.at, 0xa8d0ff, 2500, 0.1);
        }
      }
      // Light, ring, shake decay.
      flash = Math.max(0, flash - (flash / Math.max(0.03, flashLife)) * wall * 2.5);
      // Falls off with the distance in world units: the same flash in metres at any unit.
      light.intensity = flash * TUNED_UNIT ** light.decay;
      // Always in the scene, dark when off
      light.visible = true;
      shakeAmp *= Math.exp(-wall * 4);
      if (shakeAmp < 1e-3) shakeAmp = 0;
      if (ringAge < 0.7) {
        ringAge += wall;
        const k = ringAge / 0.7;
        const r = ringReach * (1 - (1 - k) ** 2);
        ring.visible = true;
        ring.position.copy(ringAt);
        ring.scale.set(r, 1, r);
        ringMaterial.opacity = 0.55 * (1 - k);
      } else ring.visible = false;
      // Draw the pieces - rewritten only while one moves or the set changes: a street of rubble at rest costs nothing a frame.
      const moving = pieces.some((b) => !b.asleep);
      const redraw = moving || pieces.length !== drawnPieces;
      drawnPieces = pieces.length;
      let nb = 0, nc = 0, ns = 0, nl = 0;
      if (redraw) for (const b of pieces) {
        o.position.copy(b.p);
        o.quaternion.copy(b.q);
        o.scale.copy(b.size);
        o.updateMatrix();
        // Burnt black as it burns.
        if (b.mesh === 'box') { boxes.setMatrixAt(nb, o.matrix); boxes.setColorAt(nb++, b.color); }
        else if (b.mesh === 'car') { if (ns < 80) { shells.setMatrixAt(ns, o.matrix); shells.setColorAt(ns++, b.color); } }
        else if (b.mesh === 'slab') { slabs.setMatrixAt(nl, o.matrix); slabs.setColorAt(nl++, b.color); }
        else if (b.mesh === 'mesh') { if (b.object) { b.object.position.copy(b.p); b.object.quaternion.copy(b.q); } }
        else { cylinders.setMatrixAt(nc, o.matrix); cylinders.setColorAt(nc++, b.color); }
      }
      if (redraw) {
        boxes.count = nb; cylinders.count = nc; shells.count = ns; slabs.count = nl;
        for (const mesh of [boxes, cylinders, shells, slabs]) uploadWritten(mesh);
      }
      const counts = [0, 0];
      for (const c of craters) {
        c.age += wall;
        const k = c.road ? 0 : 1;
        const grow = Math.min(1, 0.4 + c.age * 6);
        o.position.set(c.x, c.z + m(0.03), -c.y);
        o.quaternion.setFromAxisAngle(tmp1.set(0, 1, 0), c.angle);
        o.scale.set(c.r * 2 * grow, 1, c.r * 2 * grow);
        o.updateMatrix();
        craterMeshes[k]!.setMatrixAt(counts[k]!++, o.matrix);
      }
      // Only what was written goes up, and nothing when there are none
      craterMeshes.forEach((mesh, k) => {
        if (k >= 2 || (counts[k] === 0 && mesh.count === 0)) return;
        mesh.count = counts[k]!;
        uploadWritten(mesh);
      });
      // Soot is still: written again only when some was added.
      if (sootDirty) {
        sootDirty = false;
        const mesh = craterMeshes[2]!;
        soots.forEach((c, i) => {
          o.position.set(c.x, c.z + m(0.025), -c.y);
          o.quaternion.setFromAxisAngle(tmp1.set(0, 1, 0), c.angle);
          o.scale.set(c.r * 2, 1, c.r * 2);
          o.updateMatrix();
          mesh.setMatrixAt(i, o.matrix);
        });
        mesh.count = soots.length;
        uploadWritten(mesh);
      }
      // An empty batch is still a program bind and its uniforms in every pass (the shadow pass too)
      for (const mesh of [boxes, cylinders, shells, slabs, ...craterMeshes]) mesh.visible = mesh.count > 0;
      let w = 0;
      for (const r of ropes) {
        for (let k = 1; k < r.p.length; k++) {
          const a = r.p[k - 1]!, b = r.p[k]!;
          wirePositions[w] = a.x; wirePositions[w + 1] = a.y; wirePositions[w + 2] = a.z;
          wirePositions[w + 3] = b.x; wirePositions[w + 4] = b.y; wirePositions[w + 5] = b.z;
          w += 6;
        }
      }
      wireGeometry.setDrawRange(0, w / 3);
      // No wires down, nothing drawn and nothing sent
      wires.visible = w > 0;
      if (w > 0) {
        const attribute = wireGeometry.getAttribute('position') as BufferAttribute;
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, w);
        attribute.needsUpdate = true;
      }
    },
    dispose() {
      for (const p of pieces) if (p.object) dropObject(p.object);
      for (const mesh of [boxes, cylinders, shells, slabs, ...craterMeshes]) mesh.dispose();
      boxes.geometry.dispose(); cylinders.geometry.dispose(); shellGeometry.dispose(); slabGeometry.dispose(); debrisMaterial.dispose();
      craterGeometry.dispose(); for (const mat of craterMaterials) { mat.map?.dispose(); mat.dispose(); }
      ring.geometry.dispose(); ringMaterial.dispose(); wireGeometry.dispose(); (wires.material as LineBasicMaterial).dispose();
    },
  };
}

const tmp1 = new Vector3(), tmp2 = new Vector3(), tmp3 = new Vector3(), tmp4 = new Vector3(), tmp5 = new Vector3();
const spinQ = new Quaternion();
/** The instances written (`count`) to the GPU, not the whole buffer (1 400 pieces' worth) each frame one moves. */
function uploadWritten(mesh: InstancedMesh): void {
  for (const a of [mesh.instanceMatrix, mesh.instanceColor]) if (a) { a.clearUpdateRanges(); if (mesh.count) a.addUpdateRange(0, mesh.count * a.itemSize); a.needsUpdate = true; }
}
