import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { weldGeometry } from '../mesh/weld';
import { dropFacing, dropHiddenFaces } from '../mesh/hiddenFaces';
import { AC, type FacadePropKind, POT_HIGH } from './facadeProps';

/** The models of the props on the facades and balconies (`facadeProps.ts` places them) */

// ------------------------------------------------------------------ models

/** A part of a model: a geometry and its tone (multiplied by the instance's colour). */
/** DO NOT `toNonIndexed` a part: every instance of the prop drew each corner once per triangle; a loose list is indexed instead (identical vertices only, so a faceted part stays faceted; three `BufferGeometryUtils.mergeVertices`). */
function tone(g: BufferGeometry, rgb: readonly [number, number, number]): BufferGeometry {
  g.deleteAttribute('uv');
  const part = g.index ? g : weldGeometry(g);
  if (part !== g) g.dispose();
  const n = part.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  part.setAttribute('color', new BufferAttribute(c, 3));
  return part;
}
const grey = (v: number): [number, number, number] => [v, v, v];

function block(w: number, h: number, d: number, x: number, y: number, z: number, rgb: readonly [number, number, number]): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tone(g, rgb);
}

/** Parts merged into one model, the faces another part covers taken out first (`mesh/hiddenFaces.ts`); `floor`: it stands on y = 0, what lies on it facing down left out too. */
function merged(parts: BufferGeometry[], floor = false): BufferGeometry {
  dropHiddenFaces(parts, floor);
  const g = mergeGeometries(parts) as BufferGeometry;
  for (const p of parts) p.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A split condenser, centred on its case: the case (its top 2 cm the lid, drawn by the material), two arms, two braces down to two plates on
 *  the wall, the two lines into the wall. Every face turned to the wall (-z) left out: no camera stands between the wall and the unit. */
function acUnitGeometry(): BufferGeometry {
  const { w, h, d, gap } = AC;
  const front = d / 2;
  const intoWall = new Vector3(0, 0, -1);
  // The case with its lid's height: the lid, 2 cm over it, is a band of the case the material tones (`AC_FRONT_GLSL`).
  const parts: BufferGeometry[] = [block(w, h + AC_LID, d, 0, AC_LID / 2, 0, grey(1))];
  // The fan's hole, its grille and the coil's louvres are drawn on the case's front by its material (`AC_FRONT_GLSL`): DO NOT model them,
  // 180 of the condenser's 316 triangles were rings, spokes and slats standing 4 to 8 mm proud of that face.
  const wall = -front - gap;
  for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) {
    // The arm under the case, out from the wall, a brace down to a plate on the wall
    parts.push(block(0.035, 0.035, d + gap + 0.07, x, -h / 2 - 0.018, (wall + front + 0.07) / 2 - 0.005, grey(0.38)));
    const brace = new BoxGeometry(0.03, 0.03, 0.36);
    brace.rotateX(-Math.PI / 4);
    brace.translate(x, -h / 2 - 0.15, wall + 0.12);
    parts.push(tone(brace, grey(0.38)));
    // The plate flat on the wall: its face alone (its 12 mm edges are a pixel's sliver).
    const plate = new PlaneGeometry(0.05, 0.3);
    plate.translate(x, -h / 2 - 0.13, wall + 0.008);
    parts.push(tone(plate, grey(0.38)));
  }
  // The lines: copper and their black insulation, out of the case's right end into the wall; four sides at 2-4 cm across.
  for (const [y, rad, rgb] of [[-0.08, 0.012, [0.72, 0.45, 0.3]], [-0.15, 0.022, [0.08, 0.08, 0.08]]] as const) {
    // Into the wall by 2 cm, its end never in the wall's plane.
    const run = gap + d / 2 + 0.04;
    const pipe = new CylinderGeometry(rad, rad, run, 4, 1, true, Math.PI / 4);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(w / 2 + 0.03, y, wall - 0.02 + run / 2);
    parts.push(tone(pipe, rgb));
  }
  for (const part of parts) dropFacing(part, intoWall);
  return merged(parts);
}

/** A plant pot from the floor (y 0) up: a tapered body, its rim and the soil in it. 0.34 m across, 0.32 m high (`POT_HIGH`). */
function potGeometry(): BufferGeometry {
  const body = new CylinderGeometry(0.16, 0.12, POT_HIGH - 0.04, 14);
  body.translate(0, (POT_HIGH - 0.04) / 2, 0);
  const rim = new CylinderGeometry(0.175, 0.168, 0.045, 14);
  rim.translate(0, POT_HIGH - 0.0225, 0);
  const soil = new CircleGeometry(0.15, 14);
  soil.rotateX(-Math.PI / 2);
  soil.translate(0, POT_HIGH - 0.03, 0);
  return merged([tone(body, grey(1)), tone(rim, grey(0.92)), tone(soil, [0.24, 0.17, 0.11])], true);
}

/** A small seeded stream for the plant's leaves: the same model every load. */
function leafStream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A potted plant's leaves from the soil (y 0) up: a rosette of leaves arching out and down */
function foliageGeometry(): BufferGeometry {
  const rnd = leafStream(0x1eaf);
  const parts: BufferGeometry[] = [];
  const leaves = 14;
  for (let k = 0; k < leaves; k++) {
    const yaw = (k / leaves) * Math.PI * 2 + rnd() * 0.4;
    const length = 0.2 + rnd() * 0.18, rise = 0.25 + rnd() * 0.25, width = 0.06 + rnd() * 0.04;
    const dark = 0.62 + rnd() * 0.38;
    // The leaf's spine: up out of the soil, then over and down, in 4 steps.
    const pos: number[] = [];
    const steps = 4;
    const cx = Math.cos(yaw), sz = Math.sin(yaw);
    // The blade twisted about its spine (40-70 degrees)
    const twist = 0.7 + rnd() * 0.5;
    const sideX = -sz * Math.cos(twist), sideY = Math.sin(twist), sideZ = cx * Math.cos(twist);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const out = length * t, up = rise * Math.sin(t * Math.PI * 0.75) + 0.05;
      const half = width * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) * 0.5 + 0.004;
      const px = cx * out, pz = sz * out;
      pos.push(px - sideX * half, up - sideY * half, pz - sideZ * half, px + sideX * half, up + sideY * half, pz + sideZ * half);
    }
    const tri: number[] = [];
    for (let s = 0; s < steps; s++) {
      const a = s * 2;
      tri.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(tri);
    g.computeVertexNormals();
    parts.push(tone(g, [0.85 * dark, dark, 0.8 * dark]));
  }
  // The clump at the heart of the plant, lumpy: an icosahedron pushed in and out.
  const clump = new IcosahedronGeometry(0.1, 1);
  const p = clump.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + 0.5 * leafStream(i * 7919 + 13)();
    p.setXYZ(i, p.getX(i) * k, Math.max(0, p.getY(i) * k * 0.9 + 0.12), p.getZ(i) * k);
  }
  clump.computeVertexNormals();
  parts.push(tone(clump, grey(0.7)));
  return merged(parts);
}

/** A balcony chair from the floor up, facing +Z: seat, a slanted back and four legs. */
function chairGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [block(0.44, 0.03, 0.42, 0, 0.44, 0.01, grey(1))];
  const back = new BoxGeometry(0.44, 0.42, 0.025);
  back.rotateX(-0.18);
  back.translate(0, 0.66, -0.19);
  parts.push(tone(back, grey(1)));
  for (const x of [-0.19, 0.19]) for (const z of [-0.17, 0.18]) parts.push(block(0.025, 0.43, 0.025, x, 0.215, z, grey(0.9)));
  // Arm rests.
  for (const x of [-0.21, 0.21]) parts.push(block(0.03, 0.025, 0.38, x, 0.63, 0, grey(0.95)));
  return merged(parts, true);
}

/** A small round table from the floor up: top, a post and its base. */
function tableGeometry(): BufferGeometry {
  const top = new CylinderGeometry(0.34, 0.34, 0.03, 18);
  top.translate(0, 0.72, 0);
  const post = new CylinderGeometry(0.03, 0.03, 0.7, 8);
  post.translate(0, 0.355, 0);
  const foot = new CylinderGeometry(0.2, 0.22, 0.025, 14);
  foot.translate(0, 0.0125, 0);
  return merged([tone(top, grey(1)), tone(post, grey(0.85)), tone(foot, grey(0.85))], true);
}

/** A floor-standing clothes airer (the varal de chao), 1.2 m along X */
function airerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const half = 0.6, top = 0.92, foot = 0.3;
  for (const x of [-half, half]) {
    for (const s of [-1, 1]) {
      const leg = new BoxGeometry(0.02, Math.hypot(top, foot), 0.02);
      leg.rotateX(s * Math.atan2(foot, top));
      leg.translate(x, top / 2, s * -foot / 2);
      parts.push(tone(leg, grey(0.9)));
    }
  }
  for (const z of [-0.2, -0.07, 0.07, 0.2]) {
    const y = top - Math.abs(z) * 0.4;
    parts.push(block(2 * half, 0.008, 0.008, 0, y, z, grey(0.85)));
  }
  // The washing, over the lines: each a thin cloth hanging both sides.
  const cloth = (x: number, z: number, w: number, drop: number, rgb: readonly [number, number, number]): void => {
    const y = top - Math.abs(z) * 0.4;
    parts.push(block(w, drop, 0.012, x, y - drop / 2, z, rgb));
  };
  cloth(-0.3, -0.07, 0.42, 0.55, [0.25, 0.42, 0.72]);
  cloth(0.18, 0.07, 0.34, 0.4, [0.85, 0.25, 0.22]);
  cloth(0.35, -0.2, 0.22, 0.6, [0.2, 0.22, 0.3]);
  cloth(-0.05, 0.2, 0.3, 0.32, [0.95, 0.93, 0.88]);
  for (const x of [-0.5, -0.42]) cloth(x, 0.2, 0.06, 0.14, [0.9, 0.85, 0.3]);
  return merged(parts, true);
}

/** A satellite dish on its wall arm, the arm's foot at the origin on the wall: the dish 0.6 m across, facing up and out. */
function dishGeometry(): BufferGeometry {
  const bowl = new SphereGeometry(0.42, 14, 4, 0, Math.PI * 2, 0, 0.8);
  bowl.rotateX(Math.PI / 2 + 0.55);
  bowl.translate(0, -0.1, 0.5);
  const arm = block(0.035, 0.035, 0.3, 0, 0, 0.15, grey(0.45));
  const mount = block(0.12, 0.16, 0.012, 0, 0, 0.006, grey(0.45));
  const feed = block(0.025, 0.025, 0.32, 0, 0.1, 0.32, grey(0.4));
  const lnb = block(0.06, 0.06, 0.09, 0, 0.12, 0.5, grey(0.15));
  return merged([tone(bowl, grey(1)), arm, mount, feed, lnb]);
}

/** A condenser from afar (`kit.ts` `far`): its case and arms; the fan and louvres drawn on the front by the material, as near. */
export function acFarGeometry(): BufferGeometry {
  const { w, h, d } = AC;
  const parts = [block(w, h + AC_LID, d, 0, AC_LID / 2, 0, grey(1))];
  for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) parts.push(block(0.035, 0.035, d + AC.gap, x, -h / 2 - 0.018, -AC.gap / 2, grey(0.38)));
  for (const part of parts) dropFacing(part, new Vector3(0, 0, -1));
  return merged(parts);
}

/** The condenser's front as its material draws it, on the case's face (+z at d / 2, model space): the fan's dark hole, the grille's three
 *  rings and two crossed spokes over it, and the coil's five louvres at the right, in the tones the modelled ones had (0.1, 0.82, 0.72);
 *  each edge smoothed over a pixel (fwidth) so they do not crawl. */
export const AC_FRONT_GLSL = /* glsl */ `
float acBand(float x, float a, float b, float aa) { return smoothstep(a - aa, a + aa, x) - smoothstep(b - aa, b + aa, x); }
float acFrontTone(vec3 p) {
  vec2 q = p.xy - vec2(${(-AC.w / 2 + 0.27).toFixed(4)}, 0.0);
  float d = length(q), aa = max(fwidth(d), 1e-5);
  float hole = 1.0 - smoothstep(0.19 - aa, 0.19 + aa, d);
  float rings = acBand(d, 0.055, 0.07, aa) + acBand(d, 0.115, 0.13, aa) + acBand(d, 0.175, 0.195, aa);
  vec2 r = vec2(q.x + q.y, q.y - q.x) * 0.70710678;
  float ra = max(fwidth(r.x), 1e-5);
  float spokes = max(1.0 - smoothstep(0.006 - ra, 0.006 + ra, abs(r.x)), 1.0 - smoothstep(0.006 - ra, 0.006 + ra, abs(r.y))) * step(d, 0.19);
  float tone = mix(1.0, 0.1, hole);
  tone = mix(tone, 0.82, clamp(rings + spokes, 0.0, 1.0));
  float lx = abs(p.x - ${(AC.w / 2 - 0.14).toFixed(4)}), la = max(fwidth(p.x), 1e-5);
  float slats = 0.0;
  for (int k = 0; k < 5; k++) slats += acBand(p.y, ${(-AC.h / 2 + 0.09 - 0.007).toFixed(4)} + float(k) * 0.07, ${(-AC.h / 2 + 0.09 + 0.007).toFixed(4)} + float(k) * 0.07, la);
  slats *= 1.0 - smoothstep(0.1 - la, 0.1 + la, lx);
  return mix(tone, 0.72, clamp(slats, 0.0, 1.0));
}
/** The lid: the case's top and its top 2 cm all round, in the lid's tone (0.93), its lower edge smoothed over a pixel. */
float acLidTone(vec3 p) {
  float aa = max(fwidth(p.y), 1e-5);
  return mix(1.0, 0.93, smoothstep(${(AC.h / 2).toFixed(4)} - aa, ${(AC.h / 2).toFixed(4)} + aa, p.y));
}`;
/** The lid's height over the case (it was a slab of its own). */
export const AC_LID = 0.02;
/** The case's front face: its model-space front (z) within this of `AC.d / 2`, facing +z. */
export const AC_FRONT_Z = AC.d / 2;

/** Every prop's model, made once (`kit.ts`). */
export function createFacadePropGeometries(): Record<FacadePropKind, BufferGeometry> {
  return {
    acUnit: acUnitGeometry(),
    pot: potGeometry(),
    foliage: foliageGeometry(),
    bush: bushGeometry(),
    lounger: loungerGeometry(),
    bike: bikeGeometry(),
    chair: chairGeometry(),
    table: tableGeometry(),
    airer: airerGeometry(),
    dish: dishGeometry(),
  };
}

/** A round potted shrub (a boxwood, a fern, a geranium) */
function bushGeometry(): BufferGeometry {
  const rnd = leafStream(0xb05);
  const parts: BufferGeometry[] = [];
  const core = new IcosahedronGeometry(0.15, 1);
  const p = core.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const k = 0.8 + 0.35 * leafStream(i * 104_729 + 7)();
    p.setXYZ(i, p.getX(i) * k, Math.max(0.01, p.getY(i) * k * 0.85 + 0.13), p.getZ(i) * k);
  }
  core.computeVertexNormals();
  parts.push(tone(core, grey(0.62)));
  for (let k = 0; k < 22; k++) {
    // A leaf on the mound, pointing out of it.
    const yaw = rnd() * Math.PI * 2, pitch = 0.2 + rnd() * 1.1;
    const nx = Math.cos(yaw) * Math.cos(pitch), ny = Math.sin(pitch), nz = Math.sin(yaw) * Math.cos(pitch);
    const leaf = new CircleGeometry(0.06 + rnd() * 0.03, 4);
    leaf.scale(0.55, 1.4, 1);
    leaf.rotateX(-Math.PI / 2 + pitch * 0.6);
    leaf.rotateY(-yaw + Math.PI / 2);
    leaf.translate(nx * 0.17, 0.13 + ny * 0.14, nz * 0.17);
    const d = 0.7 + rnd() * 0.3;
    parts.push(tone(leaf, [0.85 * d, d, 0.78 * d]));
  }
  return merged(parts);
}

/** A sun lounger (espreguicadeira) along X, from the floor up: its bed, the raised back and four short legs; 1.9 m long. */
function loungerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [block(1.3, 0.05, 0.62, 0.25, 0.32, 0, grey(1))];
  const back = new BoxGeometry(0.62, 0.05, 0.62);
  back.rotateZ(-0.75);
  back.translate(-0.62, 0.55, 0);
  parts.push(tone(back, grey(1)));
  // The cushion, a shade lighter, along the bed.
  parts.push(block(1.2, 0.05, 0.56, 0.25, 0.37, 0, grey(1.0)));
  for (const x of [-0.35, 0.85]) for (const z of [-0.26, 0.26]) parts.push(block(0.04, 0.3, 0.04, x, 0.15, z, grey(0.7)));
  return merged(parts, true);
}

/** A bicycle on its stand, along X, from the floor up: two wheels */
function bikeGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const r = 0.34, base = 0.52;
  for (const x of [-base, base]) {
    const tyre = new RingGeometry(r - 0.035, r, 18);
    tyre.translate(x, r, 0);
    parts.push(tone(tyre, grey(0.08)));
    const rim = new RingGeometry(r - 0.06, r - 0.04, 18);
    rim.translate(x, r, 0);
    parts.push(tone(rim, grey(0.75)));
  }
  // The frame: from the rear hub to the crank, up to the saddle, across to the head and down to the front hub.
  const bar = (x0: number, y0: number, x1: number, y1: number, t = 0.03): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const g = new BoxGeometry(len, t, t);
    g.rotateZ(Math.atan2(y1 - y0, x1 - x0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    parts.push(tone(g, grey(1)));
  };
  const crank: [number, number] = [-0.05, 0.3], seat: [number, number] = [-0.18, 0.78], head: [number, number] = [0.38, 0.8];
  bar(-base, r, crank[0], crank[1]);
  bar(-base, r, seat[0], seat[1]);
  bar(crank[0], crank[1], seat[0], seat[1]);
  bar(seat[0], seat[1] - 0.04, head[0], head[1] - 0.04);
  bar(crank[0], crank[1], head[0], head[1] - 0.1);
  bar(head[0], head[1], base, r);
  parts.push(block(0.22, 0.05, 0.1, seat[0] - 0.02, seat[1] + 0.05, 0, grey(0.1)));
  parts.push(block(0.04, 0.04, 0.5, head[0] - 0.03, head[1] + 0.12, 0, grey(0.15)));
  return merged(parts, true);
}

