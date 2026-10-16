import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DodecahedronGeometry,
  IcosahedronGeometry,
  MeshStandardMaterial,
  Vector3,
  type MeshDepthMaterial,
} from 'three';

import type { GeologyKind } from '@world/terrainPaint';
import type { SlotFormat } from './cellInstances';
import { leafCardMaterials, lowPolyTreeParts, type LowPolyKind } from './lowPolyTrees';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/** What stands on the open ground: rocks and boulders */

export interface CoverPlacement {
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Across, world units. */
  readonly size: number;
  readonly yaw: number;
  /** 0..1: which variant, its tilt, its tint. */
  readonly seed: number;
  /** A stone: the rock of the land it lies on (granite when absent). */
  readonly rock?: GeologyKind;
}

/** The trees a painted forest grows. */
export type ForestSpecies = 'broadleaf' | 'broadleafTall' | 'conifer' | 'ipeYellow' | 'ipePink';
export const FOREST_SPECIES: readonly ForestSpecies[] = ['broadleaf', 'broadleafTall', 'conifer', 'ipeYellow', 'ipePink'];

/** A tree: `size` is its height. */
export interface TreePlacement extends CoverPlacement {
  readonly species: ForestSpecies;
}

/** One tree model: its body and its foliage cards (none on a conifer). */
export interface TreeModel {
  readonly body: BufferGeometry;
  readonly cards: BufferGeometry | null;
}

export interface GroundCoverKit {
  readonly rocks: readonly BufferGeometry[];
  readonly scrub: readonly BufferGeometry[];
  /** Per species, its variants; one unit tall, the crown some 0.6 across. */
  readonly trees: Readonly<Record<ForestSpecies, readonly TreeModel[]>>;
  readonly rockMaterial: MeshStandardMaterial;
  readonly scrubMaterial: MeshStandardMaterial;
  readonly treeMaterial: MeshStandardMaterial;
  readonly treeDepth: MeshDepthMaterial;
  /** The foliage cards' material (`lowPolyTrees.ts` leafCardMaterials). */
  readonly cardMaterial: MeshStandardMaterial;
  dispose(): void;
}

/** The forest's sway: the crown more than the trunk, as the garden trees. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

const ROCK_VARIANTS = 5;
const SCRUB_VARIANTS = 4;

/** A deterministic 3-D value noise in -1..1, enough for a stone's or a bush's shape. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i, 374_761_393) ^ Math.imul(j, 668_265_263) ^ Math.imul(k, 1_274_126_177) ^ Math.imul(seed, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const plane = (k: number): number => lerp(
    lerp(hash(xi, yi, k), hash(xi + 1, yi, k), sx),
    lerp(hash(xi, yi + 1, k), hash(xi + 1, yi + 1, k), sx),
    sy,
  );
  return lerp(plane(zi), plane(zi + 1), sz);
}

/** A stone: 36 triangles, non-indexed so every face is flat. */
export function rockGeometry(seed: number): BufferGeometry {
  const geometry = new DodecahedronGeometry(1, 0);
  const position = geometry.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const p = new Vector3();
  // Its own proportions: some round, some long and low, some blocky.
  const stretch = 0.8 + ((seed * 0.37) % 1) * 0.5;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    // A function of the ORIGINAL position, so the copies of one corner on its faces move together and the stone stays closed.
    const big = noise3(p.x * 1.1 + seed * 7, p.y * 1.1, p.z * 1.1, seed);
    const small = noise3(p.x * 3.2, p.y * 3.2 + seed * 3, p.z * 3.2, seed + 11);
    p.multiplyScalar(1 + big * 0.32 + small * 0.1);
    p.x *= stretch;
    p.y *= 0.62;
    // A flat underside, sunk into the ground.
    if (p.y < -0.22) p.y = -0.22 + (p.y + 0.22) * 0.15;
    position.setXYZ(i, p.x, p.y, p.z);
    // Darker in the hollows, lighter on the high, weathered faces.
    const shade = 0.78 + small * 0.12 + Math.max(0, p.y) * 0.25;
    colours[i * 3] = shade;
    colours[i * 3 + 1] = shade * 0.97;
    colours[i * 3 + 2] = shade * 0.92;
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A low bush: three lumps of foliage */
export function scrubGeometry(seed: number): BufferGeometry {
  const lumps: [number, number, number, number][] = [
    [0, 0.05, 0, 0.62],
    [0.42, -0.08, 0.18 - (seed % 3) * 0.12, 0.42],
    [-0.36, -0.1, -0.22 + (seed % 2) * 0.3, 0.38],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const p = new Vector3();
  const n = new Vector3();
  lumps.forEach(([cx, cy, cz, r], lump) => {
    const solid = new IcosahedronGeometry(1, 0);
    const position = solid.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const bump = noise3(p.x * 1.7 + seed * 5 + lump * 3, p.y * 1.7, p.z * 1.7, seed + lump);
      // Shaded as a round crown (the normal from the lump's centre), not as its 20 facets
      n.copy(p).normalize();
      normals.push(n.x, n.y * 0.9 + 0.1, n.z);
      p.multiplyScalar(r * (1 + bump * 0.22));
      p.y *= 0.82;
      p.x += cx;
      p.y += cy + 0.32;
      p.z += cz;
      // Never below the ground it stands on.
      if (p.y < 0) p.y *= 0.2;
      positions.push(p.x, p.y, p.z);
      // Dark at the foot, the sunlit top well lighter: a bush must stand out of the shaded scrubland ground it grows on.
      const shade = 0.55 + Math.min(1, p.y / 0.95) * 0.75 + bump * 0.06;
      colours.push(shade, shade, shade);
    }
    solid.dispose();
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.computeBoundingSphere();
  return geometry;
}


/** Each forest species as the game's one tree style grows it (`lowPolyTrees.ts`). */
const FOREST_KIND: Readonly<Record<ForestSpecies, LowPolyKind>> = {
  broadleaf: 'oak', broadleafTall: 'broadleafTall', conifer: 'cypress', ipeYellow: 'ipeYellow', ipePink: 'ipePink',
};

/** A tree one unit tall, in the game's one style (`lowPolyTrees.ts`) */
export function treeModel(species: ForestSpecies, seed: number): TreeModel {
  return lowPolyTreeParts(FOREST_KIND[species], 0x5f0e + seed * 7919 + species.length * 131);
}

export function createGroundCoverKit(): GroundCoverKit {
  const rocks = Array.from({ length: ROCK_VARIANTS }, (_, k) => rockGeometry(k * 17 + 3));
  const scrub = Array.from({ length: SCRUB_VARIANTS }, (_, k) => scrubGeometry(k * 7 + 5));
  const trees: Record<ForestSpecies, TreeModel[]> = {
    broadleaf: [treeModel('broadleaf', 1), treeModel('broadleaf', 4)],
    broadleafTall: [treeModel('broadleafTall', 2), treeModel('broadleafTall', 5)],
    conifer: [treeModel('conifer', 0), treeModel('conifer', 2)],
    ipeYellow: [treeModel('ipeYellow', 3)],
    ipePink: [treeModel('ipePink', 1)],
  };
  // Faceted, as every tree of the game (`lowPolyTrees.ts`).
  const treeMaterial = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.35, flatShading: true });
  applyWind(treeMaterial, FOREST_WIND, 'forest-crown');
  const treeDepth = windDepthMaterial(FOREST_WIND, 'forest-crown-depth');
  const cardKit = leafCardMaterials(FOREST_WIND, 'forest');
  // Weathered stone and leaves: rough, no sheen of the sky on them.
  const rockMaterial = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.25 });
  const scrubMaterial = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.2 });
  return {
    rocks,
    scrub,
    trees,
    rockMaterial,
    scrubMaterial,
    treeMaterial,
    treeDepth,
    cardMaterial: cardKit.material,
    dispose() {
      for (const geometry of [...rocks, ...scrub]) geometry.dispose();
      for (const model of FOREST_SPECIES.flatMap((s) => trees[s])) {
        model.body.dispose();
        model.cards?.dispose();
      }
      rockMaterial.dispose();
      scrubMaterial.dispose();
      treeMaterial.dispose();
      treeDepth.dispose();
      cardKit.material.dispose();
      cardKit.depth.dispose();
    },
  };
}

/** A stone's colour: warm grey with some brown and some moss-green ones. */
export function rockTint(item: CoverPlacement, out: Color): Color {
  const t = (item.seed * 9.73) % 1;
  // The rock of the land it broke from: orange sandstone, near-black basalt.
  if (item.rock === 'sandstone') {
    if (t < 0.7) return out.setRGB(0.3 + t * 0.06, 0.16 + t * 0.04, 0.085 + t * 0.02);
    return out.setRGB(0.36, 0.25, 0.15);
  }
  if (item.rock === 'basalt') {
    if (t < 0.75) return out.setRGB(0.06 + t * 0.02, 0.058 + t * 0.018, 0.055 + t * 0.016);
    return out.setRGB(0.1, 0.065, 0.045);
  }
  // LINEAR values (three's colour management): 0.17 is a mid grey on screen
  if (t < 0.6) return out.setRGB(0.15 + t * 0.06, 0.145 + t * 0.05, 0.13 + t * 0.04);
  if (t < 0.85) return out.setRGB(0.17, 0.125, 0.085);
  return out.setRGB(0.11, 0.135, 0.075);
}

/** A bush's colour: greens from olive to deep, a few going yellow. Linear. */
export function scrubTint(item: CoverPlacement, out: Color): Color {
  const t = (item.seed * 7.31) % 1;
  if (t < 0.45) return out.setRGB(0.08 + t * 0.05, 0.17 + t * 0.07, 0.03);
  if (t < 0.85) return out.setRGB(0.1, 0.2, 0.04);
  return out.setRGB(0.17, 0.2, 0.05);
}

/** How each kind of cover stands: sunk by a share of its height, tilted, and whether it stands straight (a tree). */
export const COVER_STANCE = {
  rocks: { sink: 0.12, tilt: 0.35, upright: false },
  scrub: { sink: 0.05, tilt: 0.12, upright: false },
  trees: { sink: 0, tilt: 0.05, upright: true },
} as const;

/** A cover's variant among `variants`, by its seed. */
export const coverVariant = (item: CoverPlacement, variants: number): number => Math.min(variants - 1, Math.floor(item.seed * variants));

/** One placement's pose, into `out` at `at` (`COVER_POSE`): on its ground, turned, leaning a little, sized by its kind. */
export function coverPoseInto(item: CoverPlacement, sink: number, tilt: number, upright: boolean, out: { [i: number]: number }, at: number): void {
  const half = item.size / 2;
  out[at] = item.x; out[at + 1] = item.z - half * sink; out[at + 2] = -item.y;
  out[at + 3] = item.yaw;
  out[at + 4] = ((item.seed * 31.7) % 1 - 0.5) * tilt;
  if (upright) {
    // A tree keeps its proportions, a little narrower or broader.
    const spread = 0.9 + ((item.seed * 5.3) % 1) * 0.25;
    out[at + 5] = half * 2 * spread; out[at + 6] = half * 2; out[at + 7] = half * 2 * spread;
  } else {
    const squat = 0.75 + ((item.seed * 5.3) % 1) * 0.5;
    out[at + 5] = half; out[at + 6] = half * squat; out[at + 7] = half * (0.8 + ((item.seed * 13.1) % 1) * 0.4);
  }
}

/** Three's `compose` (r186 `Matrix4.compose`) of a turn by `yaw` about the up axis times a lean by `lean` about the model's x (`setFromAxisAngle`, `multiplyQuaternions`, zero terms dropped). */
function leanedMatrixInto(out: { [i: number]: number }, at: number, px: number, py: number, pz: number, yaw: number, lean: number, sx: number, sy: number, sz: number): void {
  const ty = Math.sin(yaw / 2), tw = Math.cos(yaw / 2);
  const lx = Math.sin(lean / 2), lw = Math.cos(lean / 2);
  const x = tw * lx, y = ty * lw, z = -(ty * lx), w = tw * lw;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[at] = (1 - (yy + zz)) * sx; out[at + 1] = (xy + wz) * sx; out[at + 2] = (xz - wy) * sx; out[at + 3] = 0;
  out[at + 4] = (xy - wz) * sy; out[at + 5] = (1 - (xx + zz)) * sy; out[at + 6] = (yz + wx) * sy; out[at + 7] = 0;
  out[at + 8] = (xz + wy) * sz; out[at + 9] = (yz - wx) * sz; out[at + 10] = (1 - (xx + yy)) * sz; out[at + 11] = 0;
  out[at + 12] = px; out[at + 13] = py; out[at + 14] = pz; out[at + 15] = 1;
}

/** A cover kept as its pose (`coverPoseInto`): place in the scene's frame, yaw, lean and scale on three axes (8 floats, not 12). */
export const COVER_POSE: SlotFormat = {
  stride: 8,
  matrixInto(data, at, out, outAt) {
    leanedMatrixInto(out, outAt, data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!, data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
  },
};

/** A tree's tint: its own colour is in its vertices; this only varies it a little. */
export function treeTint(item: CoverPlacement, out: Color): Color {
  const seed = item.seed;
  const t = 0.86 + ((seed * 3.77) % 1) * 0.28;
  return out.setRGB(t * (0.97 + ((seed * 1.3) % 1) * 0.06), t, t * 0.96);
}
