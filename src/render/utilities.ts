import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  BufferAttribute,
  InstancedBufferGeometry,
  type InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
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
} from 'three';

import type { Network } from '@world/network';
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
  type PoleArms,
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
/** A drawn cable's width as the eye sees it: the mean width of the tube's square section turned every way (perimeter / pi). */
export const WIRE_WIDTH = (4 * Math.SQRT2 * WIRE_RADIUS) / Math.PI;
/** A cable at least this many pixels wide is drawn as the tube; a thinner one as a strip square to the eye. */
const WIRE_TUBE_PIXELS = 1.5;
/** A cable keeps its width down to the first of these, in pixels, and none of it at the second: its coverage fades out (`WIRE_GLSL`). */
export const WIRE_FADE = [1 / 8, 1 / 32] as const;
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/** The overhead utility network on screen: poles, cross-arms, wires and lamps. */

export interface Utilities {
  readonly group: Object3D;
  readonly triangles: number;
  dispose(): void;
}

export interface Placement {
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

/** The instanced parts of a pole, by index into `polePartSpecs` and `placePole`'s lists. */
const POLE_PART = {
  mast: 0, arm: 1, cap: 2, brace: 3, insulator: 4, can: 5, lampArm: 6, lampHead: 7, lens: 8, pool: 9, beam: 10,
} as const;
export const POLE_PART_COUNT = 11;

/** A shape a part may be drawn with, and how far (world units) its outline strays from the part's own. */
export interface PartLevel {
  readonly geometry: BufferGeometry;
  readonly error: number;
}

/** One instanced part: its mesh's name, shape and material, and how it takes light and shadow. */
export interface PolePartSpec {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder: number;
  /** The light a lamp throws on the street (pool, beam): drawn at any size, seen at night from across the map. */
  readonly glows: boolean;
  /** How many times a lit surface's brightness it shines: a lens lit at night is seen smaller than a pixel (coverage times brightness). */
  readonly brightness: () => number;
  /** Its shapes, finest first: the first is `geometry`, the others coarser (`PoleLayer` picks by the error on the screen). */
  readonly levels: readonly PartLevel[];
}

const unlit = (): number => 1;

/** The parts in `POLE_PART` order: the catalogue's shapes and materials, the lamps' light from the scenery's kit. */
export function polePartSpecs(kit: SceneryKit): readonly PolePartSpec[] {
  const { metal, timber, housing, porcelain, steel, mastLevels, capGeometry, insulatorGeometry, canGeometry, boxGeometry, lensGeometry } = PARTS;
  const solid = (name: string, geometry: BufferGeometry, material: Material, levels: readonly PartLevel[] = [{ geometry, error: 0 }]): PolePartSpec =>
    ({ name, geometry, material, castShadow: true, receiveShadow: true, renderOrder: 0, glows: false, brightness: unlit, levels });
  const light = (name: string, geometry: BufferGeometry, material: Material, renderOrder: number): PolePartSpec =>
    ({ name, geometry, material, castShadow: false, receiveShadow: false, renderOrder, glows: true, brightness: unlit, levels: [{ geometry, error: 0 }] });
  // The lens shines the kit's glow, brighter at night (`SceneryKit.setNight`).
  const lens: PolePartSpec = {
    name: 'utility-lamp-lenses', geometry: lensGeometry, material: kit.glow, castShadow: false, receiveShadow: true, renderOrder: 0,
    glows: false, brightness: () => Math.max(1, kit.glow.color.r, kit.glow.color.g, kit.glow.color.b), levels: [{ geometry: lensGeometry, error: 0 }],
  };
  return [
    solid('utility-poles', mastLevels[0]!.geometry, timber, mastLevels),
    solid('utility-arms', boxGeometry, timber),
    solid('utility-caps', capGeometry, steel),
    solid('utility-braces', boxGeometry, steel),
    solid('utility-insulators', insulatorGeometry, porcelain),
    solid('utility-transformers', canGeometry, steel),
    solid('utility-lamp-arms', boxGeometry, metal),
    solid('utility-lamp-heads', boxGeometry, housing),
    lens,
    light('utility-lamp-pools', kit.pool, kit.poolGlow, 3),
    light('utility-lamp-beams', kit.beam, kit.beamGlow, 4),
  ];
}

/** The wires' materials, from the catalogue made at load. */
export function wireParts(): { readonly material: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  return { material: PARTS.wireMaterial, depth: PARTS.wireDepth };
}

/** One pole's parts, pushed onto `out` by `POLE_PART` */
export function placePole(
  pole: UtilityPole,
  top: number,
  frame: PoleArms,
  kerb: { x: number; y: number } | null,
  groundAt: (x: number, y: number) => number,
  out: Placement[][],
): void {
  const base = top - POLE_HEIGHT;
  out[POLE_PART.mast]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT / 2, yaw: 0, sx: 1, sy: 1, sz: 1 });
  // A pole cap: the weathering cap on the crown of a timber pole.
  out[POLE_PART.cap]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT + m(0.03), yaw: 0, sx: 1, sy: 1, sz: 1 });

  // An instanced box is scaled on its LOCAL X and then rotated about Y
  for (const arm of frame.arms) {
    const armZ = top - POLE_ARM_DROP;
    out[POLE_PART.arm]!.push({
      x: pole.x, y: pole.y, z: armZ, yaw: angleOf(arm),
      sx: POLE_ARM_HALF * 2, sy: POLE_ARM_THICK, sz: POLE_ARM_THICK,
    });
    // Pin insulators on the arm, one under each wire of the top course.
    for (const offset of WIRE_OFFSETS) {
      out[POLE_PART.insulator]!.push({
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
      out[POLE_PART.brace]!.push({
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
    const away = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
    out[POLE_PART.can]!.push({
      x: pole.x - away.x * (POLE_BASE_RADIUS + CAN_RADIUS),
      y: pole.y - away.y * (POLE_BASE_RADIUS + CAN_RADIUS),
      z: top - POLE_ARM_DROP - m(1.6),
      yaw: 0, sx: 1, sy: 1, sz: 1,
    });
  }

  if (!pole.lamp) return;
  // The light reaches out over the street, square to the kerb, whichever way the wires run
  const reach = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
  const reachYaw = angleOf(reach);
  const headX = pole.x + reach.x * POLE_LAMP_REACH;
  const headY = pole.y + reach.y * POLE_LAMP_REACH;
  const headZ = top - POLE_LAMP_DROP;
  out[POLE_PART.lampArm]!.push({
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
  out[POLE_PART.lampHead]!.push({ x: headX, y: headY, z: headZ - POLE_LAMP_TALL / 2, yaw: reachYaw, sx: POLE_LAMP_LONG, sy: POLE_LAMP_TALL, sz: POLE_LAMP_WIDE });
  // The lens under the head and the pool of light on the street, lit with the street lights' own materials
  const lensZ = headZ - POLE_LAMP_TALL - m(0.004);
  const below = groundAt(headX, headY);
  out[POLE_PART.lens]!.push({ x: headX, y: headY, z: lensZ, yaw: reachYaw, sx: POLE_LAMP_LONG * 0.8, sy: 1, sz: POLE_LAMP_WIDE * 0.8 });
  out[POLE_PART.pool]!.push({ x: headX, y: headY, z: below + m(0.012), yaw: 0, sx: LAMP_POOL_RADIUS, sy: 1, sz: LAMP_POOL_RADIUS });
  // And the cone of light between them.
  out[POLE_PART.beam]!.push({ x: headX, y: headY, z: lensZ, yaw: 0, sx: LAMP_BEAM_RADIUS, sy: Math.max(m(0.004), lensZ - below), sz: LAMP_BEAM_RADIUS });
}

const placing = new Object3D();
/** A part's matrix into `array` at `offset`, as `InstancedMesh.setMatrixAt` writes it. World y is mirrored into three's z. */
export function writePlacement(placement: Placement, array: Float32Array, offset: number): void {
  placing.position.set(placement.x, placement.z, -placement.y);
  placing.rotation.set(0, placement.yaw, placement.roll ?? 0);
  placing.scale.set(placement.sx, placement.sy, placement.sz);
  placing.updateMatrix();
  placing.matrix.toArray(array, offset);
}

/** Wires a span carries: every course and offset of the arms. */
export const SPAN_WIRES = WIRE_COURSES.length * WIRE_OFFSETS.length;
/** Numbers a wire's instance holds: its two ends in three's axes, its sag, its phase in the wind. */
export const WIRE_STRIDE = 8;

/** DO NOT build the wires' vertices on the CPU again. */
export function spanWires(
  span: UtilitySpan,
  a: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  b: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  out: Float32Array,
  at: number,
): void {
  const phase = (span.id * 2.399) % (Math.PI * 2);
  let o = at;
  // Every course and offset of the arms, as `sampleWire` lays them: its ends, and its sag from their distance.
  for (const course of WIRE_COURSES) {
    for (const offset of WIRE_OFFSETS) {
      const ax = a.x + a.arm.x * POLE_ARM_HALF * offset, ay = a.y + a.arm.y * POLE_ARM_HALF * offset, az = a.top - POLE_ARM_DROP + course;
      const bx = b.x + b.arm.x * POLE_ARM_HALF * offset, by = b.y + b.arm.y * POLE_ARM_HALF * offset, bz = b.top - POLE_ARM_DROP + course;
      // In three's axes: x, height, -y.
      out[o] = ax; out[o + 1] = az; out[o + 2] = -ay;
      out[o + 3] = bx; out[o + 4] = bz; out[o + 5] = -by;
      out[o + 6] = spanSag(Math.hypot(bx - ax, by - ay)); out[o + 7] = phase;
      o += WIRE_STRIDE;
    }
  }
}

/** Half-width of a drawn cable (`WIRE_GLSL`), for the wires' bounds. */
export const WIRE_HALF_WIDTH = WIRE_RADIUS;

/** One way of drawing a wire, shared by every cell's wires: a template of (t along the wire, t at the other end of its segment, corner). */
interface WireTemplate {
  readonly position: BufferAttribute;
  readonly normal: BufferAttribute;
  readonly index: BufferAttribute;
  /** Chords it bends the wire into. */
  readonly segments: number;
}

/** The tube: four faces a segment, each lit flat (`normal.x` names the face), corners 0-3 round the wire. */
function tubeTemplate(): WireTemplate {
  const segments = WIRE_SEGMENTS;
  const position = new Float32Array(segments * 16 * 3), normal = new Float32Array(segments * 16 * 3);
  const index = new Uint16Array(segments * 24);
  let v = 0, i = 0;
  const put = (t: number, other: number, corner: number, face: number): number => {
    position[v * 3] = t; position[v * 3 + 1] = other; position[v * 3 + 2] = corner;
    normal[v * 3] = face;
    return v++;
  };
  for (let s = 0; s < segments; s++) {
    const t0 = s / segments, t1 = (s + 1) / segments;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      const a = put(t0, t1, k, k), b = put(t1, t0, k, k), c = put(t1, t0, j, k), d = put(t0, t1, j, k);
      index.set([a, b, c, a, c, d], i);
      i += 6;
    }
  }
  return { position: new BufferAttribute(position, 3), normal: new BufferAttribute(normal, 3), index: new BufferAttribute(index, 1), segments };
}

/** A strip of `segments` chords square to the eye, its two edges corners 4 and 5, wound to face the eye (`WIRE_GLSL`). */
function stripTemplate(segments: number): WireTemplate {
  const vertices = (segments + 1) * 2;
  const position = new Float32Array(vertices * 3);
  const index = new Uint16Array(segments * 6);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    position.set([t, t, 4, t, t, 5], s * 6);
    // Edge 4 is `+side`, edge 5 `-side`, `side` = tangent x view ray: this order is anticlockwise as the eye sees it.
    if (s < segments) index.set([2 * s, 2 * s + 3, 2 * s + 2, 2 * s, 2 * s + 1, 2 * s + 3], s * 6);
  }
  return { position: new BufferAttribute(position, 3), normal: new BufferAttribute(new Float32Array(vertices * 3), 3), index: new BufferAttribute(index, 1), segments };
}

/** The ways of drawing a wire, finest first: the tube, then strips of 8, 4, 2 and 1 chords. Made once, at load. */
const WIRE_TEMPLATES: readonly WireTemplate[] = [tubeTemplate(), stripTemplate(8), stripTemplate(4), stripTemplate(2), stripTemplate(1)];

/** How to draw wires seen at `pixelsPerMetre` with at most `sag` of sag: a template (`wireGeometry`), or -1 when they have faded out. */
export function wireLevel(pixelsPerMetre: number, sag: number): number {
  const width = WIRE_WIDTH * pixelsPerMetre;
  if (width < WIRE_FADE[1]) return -1;
  if (width >= WIRE_TUBE_PIXELS) return 0;
  // A strip's chords stray from the parabola by sag / segments squared: the fewest chords that keep that under a pixel.
  for (let level = WIRE_TEMPLATES.length - 1; level > 1; level--) {
    const n = WIRE_TEMPLATES[level]!.segments;
    if ((sag * pixelsPerMetre) / (n * n) < 1) return level;
  }
  return 1;
}

/** A cell's wires drawn with one template: the template's shared attributes and the cell's instances (eight numbers a wire). */
export function wireGeometry(level: number, instances: InstancedInterleavedBuffer): InstancedBufferGeometry {
  const template = WIRE_TEMPLATES[level]!;
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(template.index);
  geometry.setAttribute('position', template.position);
  geometry.setAttribute('normal', template.normal);
  geometry.setAttribute('aStart', new InterleavedBufferAttribute(instances, 3, 0));
  geometry.setAttribute('aEnd', new InterleavedBufferAttribute(instances, 3, 3));
  geometry.setAttribute('aSagPhase', new InterleavedBufferAttribute(instances, 2, 6));
  return geometry;
}

/** A wire geometry let go: its instances' buffer freed on the GPU, the templates' kept (three's dispose frees every attribute it holds). */
export function releaseWireGeometry(geometry: InstancedBufferGeometry): void {
  geometry.setIndex(null);
  geometry.deleteAttribute('position');
  geometry.deleteAttribute('normal');
  geometry.dispose();
}

/** The screen the wires are drawn on: half its height in pixels, 0 before a layer has seen it (no fade). Set by `PoleLayer`. */
export const wireScreen = { uWirePixels: { value: 0 } };

/** A wire's vertex in the vertex shader, from its template and its instance (in three's axes) */
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
        // The share of its width a wire keeps where it is: all of it down to ${WIRE_FADE[0]} px wide, none at ${WIRE_FADE[1]} (pixels <= 0: all).
        float wireKeep(vec3 p, float pixels) {
          if (pixels <= 0.0) return 1.0;
          float depth = isPerspectiveMatrix(projectionMatrix) ? max(-(modelViewMatrix * vec4(p, 1.0)).z, 1e-4) : 1.0;
          float wide = ${WIRE_WIDTH.toFixed(6)} * pixels * projectionMatrix[1][1] / depth;
          return smoothstep(${WIRE_FADE[1].toFixed(6)}, ${WIRE_FADE[0].toFixed(6)}, wide);
        }
        vec3 wirePosition(out vec3 n, float pixels) {
          vec3 p = wireAt(position.x);
          float keep = wireKeep(p, pixels);
          if (position.z > 3.5) {
            // A strip across the curve's tangent, square to the ray from the eye; its normal leans out to its edges as a round cable's.
            vec3 d = aEnd - aStart;
            d.y += 4.0 * aSagPhase.x * (position.x * 2.0 - 1.0);
            d = normalize(d);
            vec3 ray = isPerspectiveMatrix(projectionMatrix) ? p - cameraPosition : -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
            vec3 side = cross(d, ray);
            float sl = length(side);
            side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
            float s = position.z < 4.5 ? 1.0 : -1.0;
            n = normalize(normalize(cross(d, side)) + s * side);
            return p + side * (s * ${(WIRE_WIDTH / 2).toFixed(6)} * keep);
          }
          // The tube: the frame of the vertex's segment, from its chord.
          vec3 d = wireAt(max(position.x, position.y)) - wireAt(min(position.x, position.y));
          float dl = length(d);
          d /= dl > 0.0 ? dl : 1.0;
          vec3 u = vec3(-d.z, 0.0, d.x);
          float ul = length(u);
          u = u / (ul > 0.0 ? ul : 1.0) * ${WIRE_RADIUS.toFixed(6)};
          vec3 w = cross(u, d);
          float wl = length(w);
          w = w / (wl > 0.0 ? wl : 1.0) * ${WIRE_RADIUS.toFixed(6)};
          n = normalize(wireCorner(u, w, normal.x) + wireCorner(u, w, mod(normal.x + 1.0, 4.0)));
          return p + wireCorner(u, w, position.z) * keep;
        }`;

/** The wires' materials: lit with the wind, and the shadow's depth, both bending the template along each wire. */
function wireMaterials(): { readonly lit: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  // A wire thinner than a pixel is a strip whose coverage fades (`WIRE_FADE`).
  const lit = new MeshStandardMaterial({ color: 0x1e2224, roughness: 0.55, metalness: 0.3, side: DoubleSide });
  lit.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uWireAmp: { value: WIRE_SWING } }, wireScreen);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_WIND_UNIFORMS_GLSL}
        uniform float uWirePixels;${WIRE_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec3 wireNormal;
        vec3 wirePoint = wirePosition(wireNormal, uWirePixels);
        vec3 objectNormal = wireNormal;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = wirePoint;
        float wireT = position.x;
        float wireSwing = 4.0 * wireT * (1.0 - wireT);${wireWindGlsl('wireSwing', 'aSagPhase.y')}`);
  };
  lit.customProgramCacheKey = () => 'wire-instanced';
  // The shadow as it was: the wire at rest, without the wind, at its full width.
  // // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`), nothing reads the packed colour (AGT-35).
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_GLSL}`)
      .replace('#include <begin_vertex>', `
        vec3 wireNormal;
        vec3 transformed = wirePosition(wireNormal, 0.0);`);
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
  /** The mast, finest first (`mastShape`). */
  readonly mastLevels: readonly PartLevel[];
  readonly capGeometry: CylinderGeometry;
  readonly insulatorGeometry: CylinderGeometry;
  readonly canGeometry: CylinderGeometry;
  readonly boxGeometry: BoxGeometry;
  readonly lensGeometry: BufferGeometry;
}
/** Made once, at load (`PARTS`, the end of this file), never disposed (a few materials and small shapes) */
function makeUtilityParts(): UtilityParts {
  const parts = madeUtilityParts();
  // Each shape's bounds once, at load: the pole layer grows its meshes' bounds from the spheres, and sizes a piece on the screen from the boxes.
  for (const geometry of [...parts.mastLevels.map((level) => level.geometry), parts.capGeometry, parts.insulatorGeometry, parts.canGeometry, parts.boxGeometry, parts.lensGeometry]) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
  return parts;
}

function madeUtilityParts(): UtilityParts {
  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  // Creosoted timber: a grain of long streaks up the pole, a few knots and checks
  const timber = new MeshStandardMaterial({
    color: 0xffffff,
    map: woodTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  // The luminaire as seen from above: its housing.
  const housing = new MeshStandardMaterial({ color: 0xa9b0ad, roughness: 0.5, metalness: 0.3 });
  const wires = wireMaterials();
  return {
    metal, timber, housing, wireMaterial: wires.lit, wireDepth: wires.depth,
    // A pin insulator: a glazed porcelain bell on a short pin.
    porcelain: new MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.25, metalness: 0 }),
    steel: new MeshStandardMaterial({ color: 0x8c9590, roughness: 0.45, metalness: 0.55 }),
    mastLevels: [12, 6, 3].map(mastShape),
    capGeometry: new CylinderGeometry(POLE_TOP_RADIUS * 0.4, POLE_TOP_RADIUS * 1.15, m(0.08), 10),
    insulatorGeometry: new CylinderGeometry(INSULATOR_RADIUS * 0.55, INSULATOR_RADIUS, INSULATOR_TALL, 10),
    canGeometry: new CylinderGeometry(CAN_RADIUS, CAN_RADIUS, m(0.95), 14),
    boxGeometry: new BoxGeometry(1, 1, 1),
    // One face, looking down: a lens only shines down (see `lampLensGeometry`).
    lensGeometry: new PlaneGeometry(1, 1).rotateX(Math.PI / 2),
  };
}

/** The mast with `sides` sides and no base (it stands in the ground); a coarse one as wide as the round one on average */
function mastShape(sides: number): PartLevel {
  // A polygon's mean width is its perimeter over pi: 2 n R sin(pi / n) / pi = 2 r.
  const widen = sides >= 12 ? 1 : Math.PI / (sides * Math.sin(Math.PI / sides));
  const geometry = new CylinderGeometry(POLE_TOP_RADIUS * widen, POLE_BASE_RADIUS * widen, POLE_HEIGHT, sides);
  // three's groups: the side, the top, then the base (`CylinderGeometry.generateCap`).
  const base = geometry.groups[2]!;
  geometry.setIndex(new BufferAttribute((geometry.index!.array as Uint16Array).slice(0, base.start), 1));
  geometry.clearGroups();
  // How far its outline strays from a round mast at the foot: outside at a corner, inside mid-face.
  const r = POLE_BASE_RADIUS, R = r * widen;
  const error = sides >= 12 ? 0 : Math.max(R - r, r - R * Math.cos(Math.PI / sides));
  return { geometry, error };
}

/** Ground a pole stands on: the footway where there is one, the terrain where there is not. */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  /** The network, to stand a pole level with a footway laid flush (`footwayRiseAt`). */
  net?: Network,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + (net ? footwayRiseAt(net, x, y) : FOOTWAY_RISE);
  };
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

/** DO NOT make them lazily on the first build again: that is a material made in a frame. */
const PARTS: UtilityParts = makeUtilityParts();
