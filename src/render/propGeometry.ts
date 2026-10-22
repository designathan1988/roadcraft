import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  SphereGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { cylinderWith } from './mesh/cylinder';
import { dropHiddenFaces } from './mesh/hiddenFaces';

import { Rng } from '@core/rng';
import { lowPolyTreeParts, type LowPolyKind, type LowPolyParts } from './lowPolyTrees';
import { m } from '@world/units';
import { TREE_PIT } from '@world/streetFurniture';
import { CURB_BAND, FOOTWAY_RISE } from '@world/roadTypes';

/** Procedural geometry for everything that stands on the ground. */

type Rgb = readonly [number, number, number];

const rgb = (hex: number): Rgb => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

interface Placement {
  readonly at?: readonly [number, number, number];
  readonly rotate?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
}

/** Normalises a primitive into the shared layout - indexed, position, normal and colour only. A colour read per face (it takes
 *  `face`) keeps each triangle's own corners, so each triangle is speckled on its own as before; every other part keeps its shared corners
 *  (a box 24 corners, not 36; a drum's side one ring a row): the same triangles, a third fewer vertices to shade
 *  ([meshoptimizer: vertex reuse](https://github.com/zeux/meshoptimizer#vertex-cache-optimization)). */
function part(
  geometry: BufferGeometry,
  /** A flat colour, or one per vertex given its position, normal and face centre. */
  color: Rgb | ((p: Vector3, n: Vector3, face: Vector3) => Rgb),
  placement: Placement = {},
): BufferGeometry {
  const faceted = typeof color === 'function' && color.length >= 3;
  let g = geometry;
  if (faceted && g.index) {
    g = geometry.toNonIndexed();
    geometry.dispose();
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  const matrix = new Matrix4().compose(
    new Vector3(...(placement.at ?? [0, 0, 0])),
    new Quaternion().setFromEuler(new Euler(...(placement.rotate ?? [0, 0, 0]))),
    new Vector3(...(placement.scale ?? [1, 1, 1])),
  );
  g.applyMatrix4(matrix);
  const position = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const colors = new Float32Array(position.count * 3);
  const p = new Vector3();
  const n = new Vector3();
  const face = new Vector3();
  const corner = new Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i);
    if (faceted && i % 3 === 0) {
      face.set(0, 0, 0);
      for (let k = 0; k < 3 && i + k < position.count; k++) face.add(corner.fromBufferAttribute(position, i + k));
      face.multiplyScalar(1 / 3);
    }
    const c = typeof color === 'function' ? color(p, n, face) : color;
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  // A part with no index of its own (a faceted one, an icosahedron) is indexed corner by corner: every part merged indexed.
  if (!g.index) g.setIndex(Array.from({ length: position.count }, (_, i) => i));
  return g;
}

/** The parts merged, the faces no one sees taken out first (`hiddenFaces.ts`): a leg's foot on the ground, a bar's underside in the soil,
 *  a plate's back against its box. `floor`: the model stands on y = 0 (a drain lies below it, in the gutter). */
function merge(parts: BufferGeometry[], floor = true): BufferGeometry {
  dropHiddenFaces(parts, floor);
  const merged = mergeGeometries(parts.map((g) => {
    g.clearGroups();
    return g;
  }), false);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('prop parts could not be merged');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** A box with the faces of `drop` left out (three's BoxGeometry groups: +x, -x, +y, -y, +z, -z): its ends sunk in a housing, its top under a dome. */
function boxWithout(w: number, h: number, d: number, drop: readonly ('px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz')[]): BufferGeometry {
  const box = new BoxGeometry(w, h, d);
  const order = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
  const index = box.index!;
  const kept: number[] = [];
  for (const group of box.groups) {
    if (drop.includes(order[group.materialIndex ?? 0]!)) continue;
    for (let i = group.start; i < group.start + group.count; i++) kept.push(index.getX(i));
  }
  const remap = new Int32Array(box.getAttribute('position').count).fill(-1);
  let used = 0;
  for (const v of kept) if (remap[v] === -1) remap[v] = used++;
  const out = new BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const attribute = box.getAttribute(name);
    const array = new Float32Array(used * 3);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v]!;
      if (to >= 0) for (let k = 0; k < 3; k++) array[to * 3 + k] = attribute.array[v * 3 + k]!;
    }
    out.setAttribute(name, new BufferAttribute(array, 3));
  }
  out.setIndex(kept.map((v) => remap[v]!));
  box.dispose();
  return out;
}

/** Per-face hash, so a crown is speckled leaf by leaf rather than smooth. */
function faceNoise(p: Vector3, seed: number): number {
  const h = Math.sin(p.x * 91.7 + p.y * 47.3 + p.z * 63.1 + seed * 12.9) * 43758.5453;
  return h - Math.floor(h);
}

// ------------------------------------------------------------------ species

export type TreeSpecies = 'broadleaf' | 'broadleafTall' | 'conifer' | 'ipeYellow' | 'ipePink';
export const TREE_SPECIES: readonly TreeSpecies[] = ['broadleaf', 'broadleafTall', 'conifer', 'ipeYellow', 'ipePink'];

/** Each street and garden species as the game's one tree style grows it (`lowPolyTrees.ts`). */
const TREE_KIND: Readonly<Record<TreeSpecies, LowPolyKind>> = {
  broadleaf: 'oak', broadleafTall: 'broadleafTall', conifer: 'cypress', ipeYellow: 'ipeYellow', ipePink: 'ipePink',
};

/** A street or garden tree's body and its foliage cards (`lowPolyTrees.ts`). */
export function treeParts(species: TreeSpecies): LowPolyParts {
  return lowPolyTreeParts(TREE_KIND[species], 0x7ee + species.length * 131 + species.charCodeAt(3));
}

export type BushKind = 'bush' | 'bushFlowering' | 'hedge';
export const BUSH_KINDS: readonly BushKind[] = ['bush', 'bushFlowering', 'hedge'];

/** A bush's or hedge's body and its foliage cards (`lowPolyTrees.ts`). */
export function bushParts(kind: BushKind): LowPolyParts {
  return lowPolyTreeParts(kind, 0xb05 + kind.length * 17);
}

/** A tuft of grass: seven tapered blades leaning out from one root, dark at the base and pale at the tip. */
export function grassTuftGeometry(): BufferGeometry {
  const rng = new Rng(0x6a55);
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const root = rgb(0x39591f);
  const tip = rgb(0xa9c25e);
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + rng.float() * 0.7;
    const lean = 0.12 + rng.float() * 0.34;
    const height = 0.6 + rng.float() * 0.4;
    // Far wider than a real blade (a centimetre or less)
    const width = 0.07 + rng.float() * 0.035;
    const ox = (rng.float() - 0.5) * 0.14;
    const oz = (rng.float() - 0.5) * 0.14;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    // Across the blade, perpendicular to its lean.
    const sx = -dz;
    const sz = dx;
    const point = (t: number, side: number): [number, number, number] => {
      const out = lean * t * t;
      const w = width * (1 - t) * side;
      return [ox + dx * out + sx * w, height * t * (1 - lean * 0.25 * t), oz + dz * out + sz * w];
    };
    const tint = (t: number): Rgb => [
      root[0] + (tip[0] - root[0]) * t,
      root[1] + (tip[1] - root[1]) * t,
      root[2] + (tip[2] - root[2]) * t,
    ];
    // The blade's edges at 0, 0.45 and 0.8 of its height and its tip: seven corners shared by its five triangles, not fifteen.
    const base = positions.length / 3;
    for (const t of [0, 0.45, 0.8]) {
      positions.push(...point(t, -1), ...point(t, 1));
      colors.push(...tint(t), ...tint(t));
    }
    positions.push(...point(1, 0));
    colors.push(...tint(1));
    for (const k of [0, 2]) index.push(base + k, base + k + 1, base + k + 3, base + k, base + k + 3, base + k + 2);
    index.push(base + 4, base + 5, base + 6);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Blades are lit as the sward they belong to: facing the sky.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** A wildflower: a stalk and a head, one unit tall. The instance colour tints it. */
export function wildflowerGeometry(): BufferGeometry {
  const stalk = rgb(0x4e7a2a);
  return merge([
    part(new CylinderGeometry(0.012, 0.016, 0.9, 4, 1, true), stalk, { at: [0, 0.45, 0] }),
    part(new BoxGeometry(0.16, 0.012, 0.05), stalk, { at: [0.06, 0.35, 0], rotate: [0, 0.4, 0.5] }),
    part(new IcosahedronGeometry(0.085, 0), [1, 1, 1], { at: [0, 0.93, 0], scale: [1, 0.55, 1] }),
  ]);
}

// ---------------------------------------------------------------- furniture

/** A residential lighting column is 8 to 10 m with a 1.5 to 2.5 m outreach. */
export const LAMP_HEIGHT = m(9);
export const LAMP_OUTREACH = m(2.1);
/** Galvanised grey, not near-black. */
const LAMP_METAL = rgb(0x8a918e);
const LAMP_PLINTH = rgb(0x5d6461);

/** A lighting column, root at the origin, arm reaching along local +X. */
export function lampGeometry(): BufferGeometry {
  const plinth = m(0.7);
  const armY = LAMP_HEIGHT - m(0.12);
  const rise = 0.1;
  return merge([
    // The plinth's top under the collar, its foot in the ground: its side alone.
    part(cylinderWith(m(0.15), m(0.19), plinth, 10, { top: false, bottom: false }), LAMP_PLINTH, { at: [0, plinth / 2, 0] }),
    part(new CylinderGeometry(m(0.2), m(0.2), m(0.05), 10), LAMP_PLINTH, { at: [0, plinth, 0] }),
    part(new CylinderGeometry(m(0.07), m(0.12), LAMP_HEIGHT - plinth, 10, 1, true), LAMP_METAL, {
      at: [0, plinth + (LAMP_HEIGHT - plinth) / 2, 0],
    }),
    part(new CylinderGeometry(m(0.09), m(0.09), m(0.2), 8), LAMP_PLINTH, { at: [0, LAMP_HEIGHT - m(0.1), 0] }),
    // The arm's ends are sunk in the column's cap and in the housing.
    part(boxWithout(LAMP_OUTREACH, m(0.08), m(0.08), ['px', 'nx']), LAMP_METAL, {
      at: [LAMP_OUTREACH / 2, armY + Math.sin(rise) * (LAMP_OUTREACH / 2), 0],
      rotate: [0, 0, rise],
    }),
    // The luminaire housing: a flat, slightly tapered shell, pale enough to read from above
    part(new BoxGeometry(m(0.78), m(0.14), m(0.38)), rgb(0xa9b0ad), {
      at: [LAMP_OUTREACH, armY + Math.sin(rise) * LAMP_OUTREACH - m(0.02), 0],
      rotate: [0, 0, rise * 0.4],
    }),
  ]);
}

/** The lighting column a dozen pixels tall or less (`streetFurnitureLayer.ts` far level): its column a four-sided prism as wide as the round one
 *  on average (a polygon's mean width is its perimeter over pi), the plinth's collar and the cap left out (centimetres there), the arm and the
 *  housing as they are. 28 triangles where the column drew 132. */
export function lampFarGeometry(): BufferGeometry {
  const armY = LAMP_HEIGHT - m(0.12);
  const rise = 0.1;
  const widen = Math.PI / (4 * Math.sin(Math.PI / 4));
  return merge([
    part(cylinderWith(m(0.07) * widen, m(0.19) * widen, LAMP_HEIGHT, 4, { top: true, bottom: false }), LAMP_METAL, { at: [0, LAMP_HEIGHT / 2, 0] }),
    part(boxWithout(LAMP_OUTREACH, m(0.08), m(0.08), ['px', 'nx']), LAMP_METAL, {
      at: [LAMP_OUTREACH / 2, armY + Math.sin(rise) * (LAMP_OUTREACH / 2), 0],
      rotate: [0, 0, rise],
    }),
    part(new BoxGeometry(m(0.78), m(0.14), m(0.38)), rgb(0xa9b0ad), {
      at: [LAMP_OUTREACH, armY + Math.sin(rise) * LAMP_OUTREACH - m(0.02), 0],
      rotate: [0, 0, rise * 0.4],
    }),
  ]);
}

/** The lamp's lens, in the lamp's own frame, for the unlit glow material. */
export function lampLensGeometry(): BufferGeometry {
  const armY = LAMP_HEIGHT - m(0.12);
  const rise = 0.1;
  return merge([
    part(new PlaneGeometry(m(0.56), m(0.28)), [1, 1, 1], {
      at: [LAMP_OUTREACH, armY + Math.sin(rise) * LAMP_OUTREACH - m(0.092), 0],
      // Face down (-Y), with the housing's slight tilt.
      rotate: [Math.PI / 2, 0, rise * 0.4],
    }),
  ]);
}

const WOOD = rgb(0x8d6540);
const IRON = rgb(0x262b2a);

/** A park bench, 1.8 m long, root at the origin. */
export function benchGeometry(): BufferGeometry {
  const L = m(1.8);
  const seat = m(0.45);
  const parts: BufferGeometry[] = [];
  const slat = (hex: Rgb, i: number): Rgb => {
    const s = 0.9 + ((i * 37) % 7) * 0.03;
    return [hex[0] * s, hex[1] * s, hex[2] * s];
  };
  [m(0.17), m(0.03), m(-0.11)].forEach((z, i) =>
    parts.push(part(new BoxGeometry(L, m(0.035), m(0.12)), slat(WOOD, i), { at: [0, seat, z] })),
  );
  [m(0.6), m(0.76)].forEach((y, i) =>
    parts.push(part(new BoxGeometry(L, m(0.1), m(0.03)), slat(WOOD, i + 3), { at: [0, y, m(-0.25) - (y - seat) * 0.12], rotate: [-0.12, 0, 0] })),
  );
  for (const end of [-1, 1]) {
    const x = end * (L / 2 - m(0.14));
    parts.push(
      part(new BoxGeometry(m(0.05), seat, m(0.05)), IRON, { at: [x, seat / 2, m(0.19)] }),
      part(new BoxGeometry(m(0.05), m(0.86), m(0.05)), IRON, { at: [x, m(0.43), m(-0.22)], rotate: [-0.1, 0, 0] }),
      part(new BoxGeometry(m(0.05), m(0.04), m(0.46)), IRON, { at: [x, seat - m(0.03), m(-0.01)] }),
      part(new BoxGeometry(m(0.06), m(0.035), m(0.42)), IRON, { at: [x, m(0.66), m(0.0)] }),
      part(new BoxGeometry(m(0.04), m(0.2), m(0.04)), IRON, { at: [x, m(0.56), m(0.18)] }),
    );
  }
  return merge(parts);
}

/** A litter bin: a 1 m drum with a steel rim and a domed lid. */
export function binGeometry(): BufferGeometry {
  const body = rgb(0x2f4a3a);
  const steel = rgb(0x8b9496);
  return merge([
    // The foot's top inside the closed drum, its bottom on the ground.
    part(cylinderWith(m(0.2), m(0.22), m(0.06), 14, { top: false, bottom: false }), rgb(0x232826), { at: [0, m(0.03), 0] }),
    part(new CylinderGeometry(m(0.23), m(0.2), m(0.8), 14, 1, true), (p) => {
      // Vertical ribs, as pressed steel panels have.
      const a = Math.atan2(p.z, p.x);
      const s = 0.9 + 0.1 * Math.cos(a * 14);
      return [body[0] * s, body[1] * s, body[2] * s];
    }, { at: [0, m(0.46), 0] }),
    // The rim's top under the lid; the dark band's top inside the rim; the lid's underside on the rim.
    part(cylinderWith(m(0.245), m(0.245), m(0.05), 14, { top: false, bottom: true }), steel, { at: [0, m(0.88), 0] }),
    part(cylinderWith(m(0.236), m(0.236), m(0.04), 14, { top: false, bottom: true }), rgb(0x0e100f), { at: [0, m(0.84), 0] }),
    part(cylinderWith(m(0.1), m(0.245), m(0.13), 14, { top: true, bottom: false }), body, { at: [0, m(0.97), 0] }),
  ]);
}

/** A pillar fire hydrant, 0.75 m. */
export function hydrantGeometry(): BufferGeometry {
  const red = rgb(0xbd3328);
  const dark = rgb(0x8f2820);
  return merge([
    part(new CylinderGeometry(m(0.16), m(0.18), m(0.07), 10), dark, { at: [0, m(0.035), 0] }),
    // The barrel's ends: on the foot and under the bonnet.
    part(cylinderWith(m(0.12), m(0.13), m(0.52), 10, { top: false, bottom: false }), red, { at: [0, m(0.33), 0] }),
    part(new CylinderGeometry(m(0.08), m(0.14), m(0.12), 10), red, { at: [0, m(0.65), 0] }),
    part(cylinderWith(m(0.035), m(0.04), m(0.07), 6, { top: true, bottom: false }), dark, { at: [0, m(0.74), 0] }),
    part(new CylinderGeometry(m(0.045), m(0.05), m(0.36), 8), dark, { at: [0, m(0.46), 0], rotate: [0, 0, Math.PI / 2] }),
    // The nozzle's back end inside the barrel (its -y end, turned to -z).
    part(cylinderWith(m(0.06), m(0.065), m(0.12), 8, { top: true, bottom: false }), dark, { at: [0, m(0.44), m(0.13)], rotate: [Math.PI / 2, 0, 0] }),
  ]);
}

/** A pillar post box: a body on a short plinth with a rounded top. Faces +Z. */
export function postboxGeometry(): BufferGeometry {
  const blue = rgb(0x1f4f8a);
  const dark = rgb(0x12304f);
  return merge([
    part(new BoxGeometry(m(0.3), m(0.25), m(0.24)), dark, { at: [0, m(0.125), 0] }),
    // The body's top under the dome.
    part(boxWithout(m(0.44), m(0.72), m(0.34), ['py']), blue, { at: [0, m(0.61), 0] }),
    // A half cylinder, axis across the box, dome up.
    part(new CylinderGeometry(m(0.17), m(0.17), m(0.44), 12, 1, false, 0, Math.PI), blue, {
      at: [0, m(0.97), 0],
      rotate: [0, 0, Math.PI / 2],
    }),
    part(new BoxGeometry(m(0.22), m(0.035), m(0.02)), rgb(0x0a0c0e), { at: [0, m(0.84), m(0.175)] }),
    part(new BoxGeometry(m(0.26), m(0.12), m(0.01)), rgb(0xe8e4d8), { at: [0, m(0.62), m(0.175)] }),
  ]);
}

/** A Brazilian public phone, the "orelhão" (Chu Ming Silveira, 1971) */
export function phoneGeometry(): BufferGeometry {
  const shell = rgb(0xe8772e);
  const inner = rgb(0xd9d4c8);
  const post = rgb(0x5d6366);
  const dark = rgb(0x1d2124);
  return merge([
    // The post's foot in the ground; its head is seen inside the open hood.
    part(cylinderWith(m(0.05), m(0.06), m(1.55), 8, { top: true, bottom: false }), post, { at: [0, m(0.775), -m(0.18)] }),
    // The shell: a stretched half-sphere, open toward +Z.
    part(new SphereGeometry(m(0.5), 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), shell, {
      at: [0, m(1.62), 0], scale: [0.9, 1.25, 0.82], rotate: [-Math.PI / 2 + 0.25, 0, 0],
    }),
    part(new SphereGeometry(m(0.47), 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), inner, {
      at: [0, m(1.62), -m(0.01)], scale: [0.88, 1.22, 0.8], rotate: [-Math.PI / 2 + 0.25, 0, 0],
    }),
    part(new BoxGeometry(m(0.2), m(0.32), m(0.1)), rgb(0x2f5fa0), { at: [0, m(1.45), -m(0.2)] }),
    part(new BoxGeometry(m(0.06), m(0.2), m(0.06)), dark, { at: [m(0.06), m(1.5), -m(0.13)] }),
  ]);
}

/** A kerb inlet ("boca de lobo"): an iron grate in the gutter, in front of a dark mouth cut into the kerb. */
export function drainGeometry(): BufferGeometry {
  const iron = rgb(0x2b2e2f);
  const concrete = rgb(0x9a9890);
  const slot = rgb(0x0b0c0d);
  const rise = FOOTWAY_RISE - m(0.03);
  const kerb = CURB_BAND;
  const parts = [
    // The mouth in the kerb face.
    part(new BoxGeometry(m(0.9), rise * 0.55, m(0.04)), slot, { at: [0, -rise * 0.62, -kerb - m(0.03)] }),
    // The lintel over it, a little proud of the kerb.
    part(new BoxGeometry(m(1.0), m(0.04), kerb + m(0.06)), concrete, { at: [0, m(0.01), -kerb / 2 - m(0.03)] }),
    // The concrete frame and the grate in the gutter.
    part(new BoxGeometry(m(1.0), m(0.02), m(0.5)), concrete, { at: [0, -rise + m(0.006), -kerb - m(0.3)] }),
  ];
  for (let i = 0; i < 7; i++) {
    parts.push(part(new BoxGeometry(m(0.035), m(0.022), m(0.4)), iron, { at: [-m(0.39) + i * m(0.13), -rise + m(0.012), -kerb - m(0.3)] }));
  }
  parts.push(part(new BoxGeometry(m(0.84), m(0.016), m(0.4)), slot, { at: [0, -rise + m(0.004), -kerb - m(0.3)] }));
  return merge(parts, false);
}

/** A tree pit in the footway: a square of dark soil behind a steel grate, root at the footway surface. */
export function treePitGeometry(): BufferGeometry {
  const soil = rgb(0x3a2c1f);
  const steel = rgb(0x3d4341);
  const half = TREE_PIT / 2;
  const parts = [part(new BoxGeometry(TREE_PIT, m(0.04), TREE_PIT), (_p, _n, face) => {
    const s = 0.85 + faceNoise(face, 2) * 0.3;
    return [soil[0] * s, soil[1] * s, soil[2] * s];
  }, { at: [0, m(0.02), 0] })];
  for (const side of [-1, 1]) {
    parts.push(
      part(new BoxGeometry(TREE_PIT, m(0.05), m(0.05)), steel, { at: [0, m(0.03), side * (half - m(0.025))] }),
      part(new BoxGeometry(m(0.05), m(0.05), TREE_PIT), steel, { at: [side * (half - m(0.025)), m(0.03), 0] }),
    );
  }
  // Grate bars, leaving the root collar open in the middle.
  for (let i = -3; i <= 3; i++) {
    if (Math.abs(i) <= 1) continue;
    parts.push(part(new BoxGeometry(m(0.025), m(0.03), TREE_PIT - m(0.1)), steel, { at: [i * (TREE_PIT / 8), m(0.035), 0] }));
  }
  return merge(parts);
}

/** Triangle count of a non-indexed prop geometry. */
export const trianglesOf = (geometry: BufferGeometry): number =>
  (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;

