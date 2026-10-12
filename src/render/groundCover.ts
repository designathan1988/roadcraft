import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DodecahedronGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type MeshDepthMaterial,
} from 'three';

import type { GeologyKind } from '@world/terrainPaint';
import { leafCardMaterials, lowPolyTreeParts, type LowPolyKind } from './lowPolyTrees';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * What stands on the open ground: rocks and boulders (the painted "rocks"
 * ground and the stones of a river's bed and banks), low scrub (the painted
 * "scrub") and the trees of a painted forest.
 *
 * All LOW-POLY by rule (the player: nothing of hundreds or thousands of
 * polygons): a stone is 36 triangles, a bush 60, a tree 70 to 190 - the
 * game's one tree style (`lowPolyTrees.ts`). A forest of thousands costs a
 * few draw calls - one instanced mesh per variant, as instanced forests are
 * drawn (three.js forum, "Procedural instanced forest").
 *
 * Each variant is a convex solid pushed in and out by layered noise, the
 * large form first and then detail at a fraction of the amplitude, as
 * procedural rock generators build them (Modo's rock item, Houdini rock
 * breakdowns); a stone squashed to a boulder's proportions with its underside
 * flattened so it sits IN the ground, a bush three lumps of foliage. One
 * instanced mesh per variant, the colour per instance.
 */

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

export interface GroundCover {
  readonly meshes: readonly InstancedMesh[];
  dispose(): void;
}

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
    // A function of the ORIGINAL position, so the copies of one corner on
    // its faces move together and the stone stays closed.
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

/**
 * A low bush: three lumps of foliage (20 triangles each), a large one and two
 * smaller ones leaning out of it, lumpy by noise, darker at the foot and
 * lighter where the sun reaches the top. 60 triangles.
 */
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
      // Shaded as a round crown (the normal from the lump's centre), not as
      // its 20 facets: faceted, a bush read as a green stone.
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
      // Dark at the foot, the sunlit top well lighter: a bush must stand out
      // of the shaded scrubland ground it grows on.
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

/**
 * A tree one unit tall, in the game's one style (`lowPolyTrees.ts`): the
 * painted woods' stand-ins, drawn only when the countryside's kit cannot be
 * grown, must not be a second kind of tree (the player, 2026-10-08). Its body
 * and its foliage cards (none on a conifer).
 */
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
function rockTint(item: CoverPlacement, out: Color): Color {
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
  // LINEAR values (three's colour management): 0.17 is a mid grey on
  // screen; the 0.4s first used drew every stone a pale chalk.
  if (t < 0.6) return out.setRGB(0.15 + t * 0.06, 0.145 + t * 0.05, 0.13 + t * 0.04);
  if (t < 0.85) return out.setRGB(0.17, 0.125, 0.085);
  return out.setRGB(0.11, 0.135, 0.075);
}

/** A bush's colour: greens from olive to deep, a few going yellow. Linear. */
function scrubTint(item: CoverPlacement, out: Color): Color {
  const t = (item.seed * 7.31) % 1;
  if (t < 0.45) return out.setRGB(0.08 + t * 0.05, 0.17 + t * 0.07, 0.03);
  if (t < 0.85) return out.setRGB(0.1, 0.2, 0.04);
  return out.setRGB(0.17, 0.2, 0.05);
}

function instanced(
  list: readonly CoverPlacement[],
  geometries: readonly BufferGeometry[],
  material: MeshStandardMaterial,
  name: string,
  tint: (item: CoverPlacement, out: Color) => Color,
  sink: number,
  tilt: number,
  upright = false,
): InstancedMesh[] {
  const byVariant: CoverPlacement[][] = Array.from({ length: geometries.length }, () => []);
  for (const item of list) byVariant[Math.min(byVariant.length - 1, Math.floor(item.seed * byVariant.length))]!.push(item);
  const meshes: InstancedMesh[] = [];
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const lean = new Quaternion();
  const scale = new Vector3();
  const colour = new Color();
  const up = new Vector3(0, 1, 0);
  const side = new Vector3(1, 0, 0);
  byVariant.forEach((items, k) => {
    if (items.length === 0) return;
    const mesh = new InstancedMesh(geometries[k]!, material, items.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    items.forEach((item, i) => {
      const half = item.size / 2;
      position.set(item.x, item.z - half * sink, -item.y);
      rotation.setFromAxisAngle(up, item.yaw);
      lean.setFromAxisAngle(side, ((item.seed * 31.7) % 1 - 0.5) * tilt);
      rotation.multiply(lean);
      if (upright) {
        // A tree keeps its proportions, a little narrower or broader.
        const spread = 0.9 + ((item.seed * 5.3) % 1) * 0.25;
        scale.set(half * 2 * spread, half * 2, half * 2 * spread);
      } else {
        const squat = 0.75 + ((item.seed * 5.3) % 1) * 0.5;
        scale.set(half, half * squat, half * (0.8 + ((item.seed * 13.1) % 1) * 0.4));
      }
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, tint(item, colour));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
  });
  return meshes;
}

/** A tree's tint: its own colour is in its vertices; this only varies it a little. */
function treeTint(item: CoverPlacement, out: Color): Color {
  const seed = item.seed;
  const t = 0.86 + ((seed * 3.77) % 1) * 0.28;
  return out.setRGB(t * (0.97 + ((seed * 1.3) % 1) * 0.06), t, t * 0.96);
}

export function buildGroundCover(
  rocks: readonly CoverPlacement[],
  scrub: readonly CoverPlacement[],
  kit: GroundCoverKit,
  trees: readonly TreePlacement[] = [],
): GroundCover {
  const forest: InstancedMesh[] = [];
  for (const species of FOREST_SPECIES) {
    const ofSpecies = trees.filter((tree) => tree.species === species);
    const models = kit.trees[species];
    // Its size is its height; it stands straight (`upright`).
    const bodies = instanced(ofSpecies, models.map((model) => model.body), kit.treeMaterial, 'forest', treeTint, 0, 0.05, true);
    // Its shadow sways with it (the forest's wind in the depth pass too).
    for (const mesh of bodies) mesh.customDepthMaterial = kit.treeDepth;
    forest.push(...bodies);
    if (models.every((model) => model.cards)) {
      // The foliage cards, on the same placements; the crown's heart throws the shadow.
      const cards = instanced(ofSpecies, models.map((model) => model.cards!), kit.cardMaterial, 'forest-cards', treeTint, 0, 0.05, true);
      for (const mesh of cards) { mesh.castShadow = false; mesh.receiveShadow = false; }
      forest.push(...cards);
    }
  }
  const meshes = [
    // A stone sunk by a fifth of its height, so it grows out of the ground.
    ...instanced(rocks, kit.rocks, kit.rockMaterial, 'rocks', rockTint, 0.12, 0.35),
    ...instanced(scrub, kit.scrub, kit.scrubMaterial, 'scrub', scrubTint, 0.05, 0.12),
    ...forest,
  ];
  return {
    meshes,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
