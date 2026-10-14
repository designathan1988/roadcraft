import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  BufferAttribute,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Mesh,
  DoubleSide,
  Material,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  RGBADepthPacking,
  PlaneGeometry,
  CanvasTexture,
  SRGBColorSpace,
  RepeatWrapping,
  Sphere,
  Vector3,
} from 'three';

import type { Network } from '@world/network';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { LAMP_BEAM_RADIUS, LAMP_POOL_RADIUS, type SceneryKit } from './scenery';
import { GROUND_ONLY, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { footwayRiseAt } from '@world/roads/footwayRise';
import {
  POLE_ARM_DROP,
  POLE_ARM_HALF,
  POLE_ARM_THICK,
  POLE_BASE_RADIUS,
  POLE_HEIGHT,
  POLE_LAMP_DROP,
  POLE_LAMP_LONG,
  POLE_LAMP_REACH,
  POLE_LAMP_TALL,
  POLE_LAMP_WIDE,
  POLE_TOP_RADIUS,
  WIRE_COURSES,
  WIRE_OFFSETS,
  WIRE_SEGMENTS,
  poleArms,
  spanSag,
} from '@world/utilities';
import { angleOf } from '@core/vec2';
import { WIRE_WIND_UNIFORMS_GLSL, windUniforms, wireWindGlsl } from './wind';

/** Pin insulator on the cross-arm. */
const INSULATOR_RADIUS = m(0.07);
const INSULATOR_TALL = m(0.2);
/** Arm braces: how far below the arm they meet the mast, and their section. */
const BRACE_DROP = m(0.55);
const BRACE_THICK = m(0.05);
/** Pole-top transformer can. */
const CAN_RADIUS = m(0.28);
/** Rise of the lamp bracket from the pole to the head. */
const LAMP_TILT = (8 * Math.PI) / 180;
/** How far a wire swings at mid-span in a full gust. */
const WIRE_SWING = m(0.35);
/** Half-width of a drawn cable: thicker than life so it reads at play zoom. */
const WIRE_RADIUS = m(0.035);
import type { PoleId, SpanId } from '@world/ids';
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/**
 * The overhead utility network on screen: poles, cross-arms, wires and lamps.
 *
 * Built exactly like every other derived structure — inside `rebuildWorld`,
 * behind the revision gate, never in a draw call. The poles and arms are
 * instanced because there are many identical ones; the wires are a single
 * `LineSegments` because a wire is one pixel wide at every zoom this game is
 * played at, and giving each one a tube would spend thousands of triangles on
 * something that reads as a line either way.
 *
 * The sag is what sells it. A straight segment between two poles reads as a
 * stick; the same span with a metre of droop reads as a cable. See
 * `world/utilities.ts` for why the curve is a quadratic and not a `cosh`.
 */

/** A pole's way to the kerb (`kerbward`), by pole, with where it stood and the roads' revision it was read at. */
export type KerbCache = Map<PoleId, { x: number; y: number; revision: number; dir: { x: number; y: number } | null }>;

export interface Utilities {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

interface Placement {
  x: number;
  y: number;
  /** Height above the ground, in world units. */
  z: number;
  yaw: number;
  /** Tilt of the part's local X axis up from level, radians (a brace, a lamp bracket). */
  roll?: number;
  sx: number;
  sy: number;
  sz: number;
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const object = new Object3D();
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, scale = 0;
  placements.forEach((placement, index) => {
    // World y is mirrored into three's z, as everywhere else in this layer.
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, placement.roll ?? 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
    const p = object.position;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); z1 = Math.max(z1, p.z);
    scale = Math.max(scale, Math.abs(placement.sx), Math.abs(placement.sy), Math.abs(placement.sz));
  });
  mesh.instanceMatrix.needsUpdate = true;
  // The sphere round the instances' places, grown by the part's own reach at
  // its largest scale: what `computeBoundingSphere` finds, a little roomier,
  // without its pass over every instance (6 ms of each road drawn on the
  // player's map, the profile of 2026-10-12; `scenery.ts` does the same).
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const part = geometry.boundingSphere!;
  const centre = new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.boundingSphere = new Sphere(centre, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + (part.center.length() + part.radius) * scale);
  return mesh;
}

/**
 * What a pole layer is built from: the document's poles and spans, or a
 * planned run (`buildPolePreview`). `draws` says which poles get a mast, arms
 * and lamp of their own here; a pole a preview only ties into is already
 * standing in the built layer.
 */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  readonly draws?: (pole: UtilityPole) => boolean;
}

export function buildUtilities(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  source: PoleSource = { poles: net.doc.poles, spans: net.doc.poleSpans },
  name = 'utilities',
  /** The built layer's kerb directions kept from its last build (`KerbCache`); left out by the preview. */
  kerbCache?: KerbCache,
): Utilities {
  const { poles, spans } = source;
  const draws = source.draws ?? (() => true);
  const group = new Group();
  group.name = name;

  const masts: Placement[] = [];
  const arms: Placement[] = [];
  const lampArms: Placement[] = [];
  const insulators: Placement[] = [];
  const braces: Placement[] = [];
  const caps: Placement[] = [];
  const cans: Placement[] = [];
  const lampHeads: Placement[] = [];
  const lenses: Placement[] = [];
  const pools: Placement[] = [];
  const beams: Placement[] = [];

  /** Crown height of each pole, so the wires and the arms agree on it. */
  const crown = new Map<number, number>();

  for (const pole of poles.values()) {
    const base = groundAt(pole.x, pole.y);
    crown.set(pole.id, base + POLE_HEIGHT);
    if (!draws(pole)) continue;

    masts.push({
      x: pole.x,
      y: pole.y,
      z: base + POLE_HEIGHT / 2,
      yaw: 0,
      sx: 1,
      sy: 1,
      sz: 1,
    });
    // A pole cap: the weathering cap on the crown of a timber pole.
    caps.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT + m(0.03), yaw: 0, sx: 1, sy: 1, sz: 1 });
  }

  /**
   * Towards the carriageway from a pole: the nearest kerb, or null off the
   * streets. Read from the kerb itself rather than from the street the
   * footway belongs to: a corner's footway belongs to no one street, and a
   * corner pole used to fall back to its cross-arm and light the block.
   */
  // Once a pole and kept from build to build while the pole and the roads
  // stay: asked three times a pole of the whole map at every rebuild, it was
  // most of the 66 rebuilds (9.5 s) a city of 1 280 m made as its power lines
  // were laid (2026-10-14).
  const kerbs: KerbCache = kerbCache ?? new Map();
  const roadward = (pole: UtilityPole): { x: number; y: number } | null => {
    const known = kerbs.get(pole.id);
    if (known && known.x === pole.x && known.y === pole.y && known.revision === net.revision) return known.dir;
    const dir = kerbward(net, { x: pole.x, y: pole.y }, m(6));
    kerbs.set(pole.id, { x: pole.x, y: pole.y, revision: net.revision, dir });
    return dir;
  };
  // The arms, framed as a line crew frames them (`poleArms`): square to a
  // straight line, on the bisector of a bend, one per line at a corner. A
  // pole with no wire yet stands square to its street.
  const framing = poleArms(poles, spans, (pole) => roadward(pole) ?? { x: 0, y: 1 });

  for (const pole of poles.values()) {
    const top = crown.get(pole.id);
    if (top === undefined || !draws(pole)) continue;
    const frame = framing.get(pole.id);

    // An instanced box is scaled on its LOCAL X and then rotated about Y, so
    // the length goes on sx and the yaw is the direction that length points
    // in. Putting the length on sz instead - which is what this did - turns
    // every arm ninety degrees, and a row of poles comes out looking twisted.
    for (const arm of frame?.arms ?? []) {
      const armZ = top - POLE_ARM_DROP;
      arms.push({
        x: pole.x,
        y: pole.y,
        z: armZ,
        yaw: angleOf(arm),
        sx: POLE_ARM_HALF * 2,
        sy: POLE_ARM_THICK,
        sz: POLE_ARM_THICK,
      });
      // Pin insulators on the arm, one under each wire of the top course.
      for (const offset of WIRE_OFFSETS) {
        insulators.push({
          x: pole.x + arm.x * POLE_ARM_HALF * offset,
          y: pole.y + arm.y * POLE_ARM_HALF * offset,
          z: armZ + POLE_ARM_THICK / 2 + INSULATOR_TALL / 2,
          yaw: 0, sx: 1, sy: 1, sz: 1,
        });
      }
      // Two flat braces from the mast up to the arm, one each side.
      for (const side of [1, -1]) {
        const reach = POLE_ARM_HALF * 0.6;
        const drop = BRACE_DROP;
        braces.push({
          x: pole.x + arm.x * side * reach / 2,
          y: pole.y + arm.y * side * reach / 2,
          z: armZ - drop / 2,
          yaw: angleOf({ x: arm.x * side, y: arm.y * side }),
          roll: Math.atan2(drop, reach),
          sx: Math.hypot(reach, drop),
          sy: BRACE_THICK,
          sz: BRACE_THICK * 0.5,
        });
      }
    }
    // A pole-top transformer on some poles, hung on the side away from the street.
    if (pole.id % 5 === 3) {
      const away = roadward(pole) ?? frame?.arms[0] ?? { x: 0, y: 1 };
      cans.push({
        x: pole.x - away.x * (POLE_BASE_RADIUS + CAN_RADIUS),
        y: pole.y - away.y * (POLE_BASE_RADIUS + CAN_RADIUS),
        z: top - POLE_ARM_DROP - m(1.6),
        yaw: 0, sx: 1, sy: 1, sz: 1,
      });
    }

    if (!pole.lamp) continue;
    // The light reaches out over the street, square to the kerb, whichever
    // way the wires run; off the streets, along the first arm.
    const reach = roadward(pole) ?? frame?.arms[0] ?? { x: 0, y: 1 };
    const reachYaw = angleOf(reach);
    const headX = pole.x + reach.x * POLE_LAMP_REACH;
    const headY = pole.y + reach.y * POLE_LAMP_REACH;
    const headZ = top - POLE_LAMP_DROP;
    lampArms.push({
      x: pole.x + reach.x * (POLE_LAMP_REACH / 2),
      y: pole.y + reach.y * (POLE_LAMP_REACH / 2),
      z: headZ - Math.tan(LAMP_TILT) * POLE_LAMP_REACH / 2,
      yaw: reachYaw,
      // The bracket rises gently from the pole to the head, as a davit does.
      roll: LAMP_TILT,
      sx: POLE_LAMP_REACH / Math.cos(LAMP_TILT),
      sy: POLE_ARM_THICK * 0.8,
      sz: POLE_ARM_THICK * 0.8,
    });
    lampHeads.push({
      x: headX,
      y: headY,
      z: headZ - POLE_LAMP_TALL / 2,
      yaw: reachYaw,
      sx: POLE_LAMP_LONG,
      sy: POLE_LAMP_TALL,
      sz: POLE_LAMP_WIDE,
    });
    // The lens under the head and the pool of light on the street, lit with
    // the street lights' own materials, so they come on at dusk with them.
    const lensZ = headZ - POLE_LAMP_TALL - m(0.004);
    const below = groundAt(headX, headY);
    lenses.push({ x: headX, y: headY, z: lensZ, yaw: reachYaw, sx: POLE_LAMP_LONG * 0.8, sy: 1, sz: POLE_LAMP_WIDE * 0.8 });
    pools.push({ x: headX, y: headY, z: below + m(0.012), yaw: 0, sx: LAMP_POOL_RADIUS, sy: 1, sz: LAMP_POOL_RADIUS });
    // And the cone of light between them.
    beams.push({ x: headX, y: headY, z: lensZ, yaw: 0, sx: LAMP_BEAM_RADIUS, sy: Math.max(m(0.004), lensZ - below), sz: LAMP_BEAM_RADIUS });
  }

  // ------------------------------------------------------------------ wires
  // Each wire is one instance of a tube the GPU bends along its sag
  // (`wireParts`): eight numbers a wire - its two ends in three's axes, its
  // sag and its phase in the wind - not the tube's vertices. Built on the
  // CPU, a wire was 8 segments x 24 vertices of position, normal, swing and
  // phase, kept three times (a cache by span, the merged buffer three keeps
  // after the upload, the GPU): the wires of a city of radius 2,560 m held
  // 426 MB of the heap (2026-10-14), and every edit near a pole merged and
  // sent the whole map's again.
  // DO NOT build the wires' vertices on the CPU again.
  const ends: number[] = [];
  for (const span of spans.values()) {
    const a = poles.get(span.a);
    const b = poles.get(span.b);
    if (!a || !b) continue;
    const topA = crown.get(a.id);
    const topB = crown.get(b.id);
    if (topA === undefined || topB === undefined) continue;

    // Each wire leaves its own insulator on the arm the span hangs from. Both
    // ends' arms are turned to the left of the span, so the wire at offset k
    // on one pole meets the wire at offset k on the next and none cross over.
    const armA = framing.get(a.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
    const armB = framing.get(b.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };

    const phase = (span.id * 2.399) % (Math.PI * 2);
    // Every course and offset of the arms, as `sampleWire` lays them: its ends, and its sag from their distance.
    for (const course of WIRE_COURSES) {
      for (const offset of WIRE_OFFSETS) {
        const ax = a.x + armA.x * POLE_ARM_HALF * offset, ay = a.y + armA.y * POLE_ARM_HALF * offset, az = topA - POLE_ARM_DROP + course;
        const bx = b.x + armB.x * POLE_ARM_HALF * offset, by = b.y + armB.y * POLE_ARM_HALF * offset, bz = topB - POLE_ARM_DROP + course;
        // In three's axes: x, height, -y.
        ends.push(ax, az, -ay, bx, bz, -by, spanSag(Math.hypot(bx - ax, by - ay)), phase);
      }
    }
  }
  if (kerbCache) for (const id of kerbCache.keys()) if (!poles.has(id)) kerbCache.delete(id);

  const { metal, timber, housing, wireMaterial, wireDepth, porcelain, steel,
    mastGeometry, capGeometry, insulatorGeometry, canGeometry, boxGeometry, lensGeometry } = utilityParts();

  const meshes = [
    instanced('utility-poles', mastGeometry, timber, masts),
    instanced('utility-arms', boxGeometry, timber, arms),
    instanced('utility-caps', capGeometry, steel, caps),
    instanced('utility-braces', boxGeometry, steel, braces),
    instanced('utility-insulators', insulatorGeometry, porcelain, insulators),
    instanced('utility-transformers', canGeometry, steel, cans),
    instanced('utility-lamp-arms', boxGeometry, metal, lampArms),
    instanced('utility-lamp-heads', boxGeometry, housing, lampHeads),
    instanced('utility-lamp-lenses', lensGeometry, kit.glow, lenses),
    instanced('utility-lamp-pools', kit.pool, kit.poolGlow, pools),
    instanced('utility-lamp-beams', kit.beam, kit.beamGlow, beams),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  for (const mesh of meshes) {
    if (mesh.name === 'utility-lamp-lenses' || mesh.name === 'utility-lamp-pools' || mesh.name === 'utility-lamp-beams') mesh.castShadow = false;
    if (mesh.name === 'utility-lamp-pools') { mesh.receiveShadow = false; mesh.renderOrder = 3; }
    if (mesh.name === 'utility-lamp-beams') { mesh.receiveShadow = false; mesh.renderOrder = 4; }
  }
  let triangles = 0;
  for (const mesh of meshes) {
    group.add(mesh);
    const index = mesh.geometry.index;
    const position = mesh.geometry.getAttribute('position');
    const perInstance = (index ? index.count : position.count) / 3;
    triangles += perInstance * mesh.count;
  }

  let wires: Mesh | null = null;
  if (ends.length > 0) {
    // One draw for every wire: the tube's template, and each wire's eight numbers as instances
    // (threejs.org InstancedBufferGeometry, example webgl_buffergeometry_instancing_interleaved).
    const data = new Float32Array(ends);
    const geometry = wireTemplate();
    const instances = new InstancedInterleavedBuffer(data, 8, 1);
    geometry.setAttribute('aStart', new InterleavedBufferAttribute(instances, 3, 0));
    geometry.setAttribute('aEnd', new InterleavedBufferAttribute(instances, 3, 3));
    geometry.setAttribute('aSagPhase', new InterleavedBufferAttribute(instances, 2, 6));
    geometry.instanceCount = data.length / 8;
    // Bounds from the wires' ends, their sag and the tube's radius: three would read the template's.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, sag = 0;
    for (let i = 0; i < data.length; i += 8) {
      for (const k of [i, i + 3]) {
        x0 = Math.min(x0, data[k]!); y0 = Math.min(y0, data[k + 1]!); z0 = Math.min(z0, data[k + 2]!);
        x1 = Math.max(x1, data[k]!); y1 = Math.max(y1, data[k + 1]!); z1 = Math.max(z1, data[k + 2]!);
      }
      sag = Math.max(sag, data[i + 6]!);
    }
    geometry.boundingSphere = new Sphere(new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + sag + WIRE_RADIUS);
    wires = new Mesh(geometry, wireMaterial);
    // The shadow drawn from the same bent tube (three draws a caster's shadow with its depth material).
    wires.customDepthMaterial = wireDepth;
    wires.castShadow = true;
    wires.name = 'utility-wires';
    group.add(wires);
  }

  return {
    group,
    triangles,
    dispose() {
      // The instances and the wires are this layer's; the parts are shared (`utilityParts`).
      for (const mesh of meshes) mesh.dispose();
      if (wires) wires.geometry.dispose();
      group.clear();
    },
  };
}

/**
 * The tube every wire is drawn from: for each of the `WIRE_SEGMENTS`
 * segments of a wire, its four faces of two triangles, in the order the
 * tubes were built on the CPU. A vertex holds no place, only what to take
 * from its wire (`WIRE_GLSL`): `position` = (segment, which end of it 0/1,
 * corner of the section 0-3), `normal.x` = the face (its normal is the sum of
 * its two corners). The wire's ends, sag and phase are its instance's.
 */
function wireTemplate(): InstancedBufferGeometry {
  const vertices = WIRE_SEGMENTS * 24;
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3);
  let v = 0;
  const put = (segment: number, end: number, corner: number, face: number): void => {
    position[v * 3] = segment; position[v * 3 + 1] = end; position[v * 3 + 2] = corner;
    normal[v * 3] = face;
    v++;
  };
  for (let i = 0; i < WIRE_SEGMENTS; i++) {
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      put(i, 0, k, k); put(i, 1, k, k); put(i, 1, j, k);
      put(i, 0, k, k); put(i, 1, j, k); put(i, 0, j, k);
    }
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  return geometry;
}

/**
 * A wire's tube in the vertex shader, the arithmetic the CPU did per segment
 * (in three's axes): the wire's point at t is its ends mixed and lowered by
 * `wireDrop` (sag * (1 - u^2), u = 2t - 1, `world/utilities.ts`); a segment
 * runs from t = i / n to (i + 1) / n; its section is u = d x up and
 * w = u x d, both `WIRE_RADIUS` long; corners u, w, -u, -w; a face's normal
 * the sum of its two corners, normalised.
 */
const WIRE_GLSL = `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute vec2 aSagPhase;
        vec3 wireAt(float t) {
          float u = t * 2.0 - 1.0;
          vec3 p = mix(aStart, aEnd, t);
          p.y -= aSagPhase.x * (1.0 - u * u);
          return p;
        }
        vec3 wireCorner(vec3 u, vec3 w, float c) {
          return c < 0.5 ? u : c < 1.5 ? w : c < 2.5 ? -u : -w;
        }
        void wireFrame(out vec3 p0, out vec3 p1, out vec3 u, out vec3 w) {
          p0 = wireAt(position.x / ${WIRE_SEGMENTS.toFixed(1)});
          p1 = wireAt((position.x + 1.0) / ${WIRE_SEGMENTS.toFixed(1)});
          vec3 d = p1 - p0;
          float dl = length(d);
          d /= dl > 0.0 ? dl : 1.0;
          u = vec3(-d.z, 0.0, d.x);
          float ul = length(u);
          u = u / (ul > 0.0 ? ul : 1.0) * ${WIRE_RADIUS.toFixed(6)};
          w = vec3(u.y * d.z - u.z * d.y, u.z * d.x - u.x * d.z, u.x * d.y - u.y * d.x);
          float wl = length(w);
          w = w / (wl > 0.0 ? wl : 1.0) * ${WIRE_RADIUS.toFixed(6)};
        }
        vec3 wirePosition() {
          vec3 p0, p1, u, w;
          wireFrame(p0, p1, u, w);
          return (position.y < 0.5 ? p0 : p1) + wireCorner(u, w, position.z);
        }`;

/** The wires' materials: lit with the wind, and the shadow's depth, both bending the template along each wire. */
function wireMaterials(): { readonly lit: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  // A wire is thinner than a pixel at any play zoom. Drawn solid near-black
  // it broke up into a dotted trace across the footway under it, which read
  // as a debug path left on screen; a faint line reads as a wire.
  const lit = new MeshStandardMaterial({ color: 0x1e2224, roughness: 0.55, metalness: 0.3, side: DoubleSide });
  lit.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uWireAmp: { value: WIRE_SWING } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_WIND_UNIFORMS_GLSL}${WIRE_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec3 nP0, nP1, nU, nW;
        wireFrame(nP0, nP1, nU, nW);
        vec3 objectNormal = normalize(wireCorner(nU, nW, normal.x) + wireCorner(nU, nW, mod(normal.x + 1.0, 4.0)));`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = wirePosition();
        float wireT = (position.x + position.y) / ${WIRE_SEGMENTS.toFixed(1)};
        float wireSwing = 4.0 * wireT * (1.0 - wireT);${wireWindGlsl('wireSwing', 'aSagPhase.y')}`);
  };
  lit.customProgramCacheKey = () => 'wire-instanced';
  // The shadow as it was: the tube at rest, without the wind.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = wirePosition();');
  };
  depth.customProgramCacheKey = () => 'wire-instanced-depth';
  return { lit, depth };
}

/** The pole layer's materials and shapes, one set for every build (the built layer and the run's preview). */
interface UtilityParts {
  readonly metal: MeshStandardMaterial;
  readonly timber: MeshStandardMaterial;
  readonly housing: MeshStandardMaterial;
  readonly wireMaterial: MeshStandardMaterial;
  readonly wireDepth: MeshDepthMaterial;
  readonly porcelain: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  readonly mastGeometry: CylinderGeometry;
  readonly capGeometry: CylinderGeometry;
  readonly insulatorGeometry: CylinderGeometry;
  readonly canGeometry: CylinderGeometry;
  readonly boxGeometry: BoxGeometry;
  readonly lensGeometry: BufferGeometry;
}
let parts: UtilityParts | null = null;
/**
 * Made once, never disposed (a few materials and small shapes): every road
 * edit near a pole made them all again, with their programs looked up anew.
 */
function utilityParts(): UtilityParts {
  if (parts) return parts;
  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  // Creosoted timber: a grain of long streaks up the pole, a few knots and
  // checks, painted once on a canvas and wrapped round the mast.
  const timber = new MeshStandardMaterial({
    color: 0xffffff,
    map: woodTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  // The luminaire as seen from above: its housing. The head used to be a box
  // in the unlit glow, which from the isometric camera was a bright white
  // mark hanging over the carriageway, read as a stray editor marker.
  const housing = new MeshStandardMaterial({ color: 0xa9b0ad, roughness: 0.5, metalness: 0.3 });
  const wires = wireMaterials();
  parts = {
    metal, timber, housing, wireMaterial: wires.lit, wireDepth: wires.depth,
    // A pin insulator: a glazed porcelain bell on a short pin.
    porcelain: new MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.25, metalness: 0 }),
    steel: new MeshStandardMaterial({ color: 0x8c9590, roughness: 0.45, metalness: 0.55 }),
    mastGeometry: new CylinderGeometry(POLE_TOP_RADIUS, POLE_BASE_RADIUS, POLE_HEIGHT, 12),
    capGeometry: new CylinderGeometry(POLE_TOP_RADIUS * 0.4, POLE_TOP_RADIUS * 1.15, m(0.08), 10),
    insulatorGeometry: new CylinderGeometry(INSULATOR_RADIUS * 0.55, INSULATOR_RADIUS, INSULATOR_TALL, 10),
    canGeometry: new CylinderGeometry(CAN_RADIUS, CAN_RADIUS, m(0.95), 14),
    boxGeometry: new BoxGeometry(1, 1, 1),
    // One face, looking down: a lens only shines down (see `lampLensGeometry`).
    lensGeometry: new PlaneGeometry(1, 1).rotateX(Math.PI / 2),
  };
  return parts;
}

/**
 * Ground a pole stands on: the footway where there is one, the terrain where
 * there is not.
 *
 * A pole beside a street is installed ON the pavement, and the pavement is a
 * kerb height above the carriageway. The terrain is shaped to meet the road,
 * so reading the bare terrain put every pole a kerb-height BELOW the surface
 * it is standing on - which is the "poles do not sit on the footway" defect.
 *
 * Only the ground level is considered. A pole must not climb onto a viaduct
 * passing overhead, and `GROUND_ONLY` is the same filter every other
 * ground-level pass uses.
 */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  /** The network, to stand a pole level with a footway laid flush (`footwayRiseAt`). */
  net?: Network,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    // A pole out on the casing margin is on the verge, not the pavement.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + (net ? footwayRiseAt(net, x, y) : FOOTWAY_RISE);
  };
}

/** A planned pole run, as the editor would build it: in order, each pole new or already standing. */
export interface PolePreviewInput {
  readonly poles: readonly { readonly x: number; readonly y: number; readonly lamp: boolean; readonly standing: boolean }[];
}

/**
 * The run under the pointer, drawn as it will stand: masts, cross-arms framed
 * as built, lamps and the sagging wires, from the same builder as the built
 * layer. A pole the run only ties into is standing already and is not drawn
 * twice; the wires to it are.
 */
export function buildPolePreview(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  input: PolePreviewInput,
): Utilities {
  const poles = new Map<PoleId, UtilityPole>();
  const spans = new Map<SpanId, UtilitySpan>();
  const standing = new Set<PoleId>();
  input.poles.forEach((pole, index) => {
    const id = (index + 1) as PoleId;
    poles.set(id, { id, x: pole.x, y: pole.y, lamp: pole.lamp });
    if (pole.standing) standing.add(id);
    if (index > 0) spans.set(index as SpanId, { id: index as SpanId, a: index as PoleId, b: id });
  });
  return buildUtilities(net, groundAt, kit, { poles, spans, draws: (pole) => !standing.has(pole.id) }, 'utility-preview');
}

let woodCache: CanvasTexture | null = null;
/** The wood of a pole: dark brown, long grain, knots and drying cracks. Shared. */
function woodTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (woodCache) return woodCache;
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4e3b2a';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Grain: thin streaks of lighter and darker wood running up the pole.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(120, 92, 64, ${0.15 + rnd() * 0.25})` : `rgba(30, 20, 12, ${0.15 + rnd() * 0.3})`;
    g.lineWidth = 0.5 + rnd() * 1.5;
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= H; y += 16) { px += (rnd() - 0.5) * 1.5; g.lineTo(px, y); }
    g.stroke();
  }
  // Knots and checks.
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H, r = 3 + rnd() * 5;
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 2);
    grad.addColorStop(0, 'rgba(25, 15, 8, 0.85)');
    grad.addColorStop(1, 'rgba(25, 15, 8, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r, r * 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 10; i++) {
    const x = rnd() * W, y = rnd() * H, len = 30 + rnd() * 90;
    g.strokeStyle = 'rgba(15, 10, 6, 0.7)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + len); g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 2);
  woodCache = t;
  return t;
}
