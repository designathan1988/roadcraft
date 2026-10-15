import {
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  type MeshDepthMaterial,
} from 'three';
import type { TreePlacement } from './groundCover';
import { leafCardMaterials, lowPolyTreeParts } from './lowPolyTrees';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { m } from '@world/units';

/** THE TREES of the countryside and the planted ones: the cypress, the palm and the oak the player drew */

/** The models, in seed order: each takes its share of the seed's range (`world/trees.ts` KIND_SLOTS). */
export const TREE_MODELS = ['oak', 'oak', 'cypress', 'cypress', 'palm', 'palm'] as const;
export type TreeModelKind = (typeof TREE_MODELS)[number];
/** A seed (0..1) that grows as this kind of tree, `r` (0..1) choosing among its models. */
export function seedOfKind(kind: TreeModelKind, r: number): number {
  const slots = TREE_MODELS.flatMap((k, i) => (k === kind ? [i] : []));
  const slot = slots[Math.min(slots.length - 1, Math.floor(r * slots.length))]!;
  return (slot + 0.05 + ((r * 7.31) % 1) * 0.9) / TREE_MODELS.length;
}
/** How far the view moves before the trees are sorted again (one level now: kept for the API). */
const LOD_SLACK = m(24);
/** Neighbours within this reach (18 m) make a tree's stand. */
const STAND_REACH = m(18);

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface Variant {
  /** The model, one unit tall on its origin (the ground); the same at every distance. */
  readonly levels: readonly [BufferGeometry, BufferGeometry, BufferGeometry];
  /** Its foliage cards (`lowPolyTrees.ts`; a palm's frond strips), drawn with the same instances. */
  readonly cards: BufferGeometry | null;
}

export interface NatureTreeKit {
  readonly variants: readonly Variant[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  readonly cardMaterial: MeshStandardMaterial;
  /** The cards' shadow pass (a palm's fronds only). */
  readonly cardDepth: MeshDepthMaterial;
  dispose(): void;
}

/** Makes the trees; their materials share the forest's wind. */
export async function loadNatureTrees(_anisotropy: number): Promise<NatureTreeKit> {
  const variants: Variant[] = TREE_MODELS.map((kind, i) => {
    const { body, cards } = lowPolyTreeParts(kind, 0x7ee5 + i * 7919);
    return { levels: [body, body, body], cards };
  });
  // Opaque, matt, faceted: the trunk and the crown's shaded heart.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(material, FOREST_WIND, 'nature-trees-lowpoly');
  const depth = windDepthMaterial(FOREST_WIND, 'nature-trees-lowpoly-depth');
  const cardKit = leafCardMaterials(FOREST_WIND, 'nature-trees');
  console.info('[nature] trees (triangles, body + cards):', variants.map((v, i) => `${TREE_MODELS[i]} ${v.levels[0].getAttribute('position').count / 3} + ${(v.cards?.getAttribute('position').count ?? 0) / 3}`).join(', '));
  return {
    variants,
    material,
    depth,
    cardMaterial: cardKit.material,
    cardDepth: cardKit.depth,
    dispose() {
      for (const v of variants) { v.levels[0].dispose(); v.cards?.dispose(); }
      material.dispose();
      depth.dispose();
      cardKit.material.dispose();
      cardKit.depth.dispose();
    },
  };
}

export interface NatureForest {
  readonly meshes: readonly InstancedMesh[];
  /** Takes these trees in place of the ones it holds, written into the meshes it already has */
  update(trees: readonly TreePlacement[]): boolean;
  /** Writes the trees into their meshes when the camera has moved (one level: the same model at every distance). */
  updateLod(x: number, y: number, z: number): void;
  dispose(): void;
}

/** The variety a tree is grown as, from its seed. */
export const varietyOf = (tree: { readonly seed: number }, varieties: number): number => Math.min(varieties - 1, Math.floor(tree.seed * varieties));

/** How many of these trees (or places a tree may stand, by seed) each variety of the kit takes: the room a forest built for them needs. */
function forestRoom(trees: readonly { readonly seed: number }[], kit: NatureTreeKit): number[] {
  const room = kit.variants.map(() => 0);
  for (const tree of trees) room[varietyOf(tree, room.length)]!++;
  return room;
}

/** A cell of the stand grid as one number (a string key per tree and neighbour was most of the cost). */
const standKey = (cx: number, cy: number): number => cx * 100_003 + cy;

/** How each tree stands among its neighbours: how crowded it is */
function stands(trees: readonly TreePlacement[]): { crowd: Float32Array; openX: Float32Array; openY: Float32Array } {
  return standsAmong(trees, trees);
}

/** How each of `trees` stands among `among` (which holds them, and every tree within `STAND_REACH` of one of them) */
export function standsAmong(trees: readonly TreePlacement[], among: readonly TreePlacement[]): { crowd: Float32Array; openX: Float32Array; openY: Float32Array } {
  const cell = STAND_REACH;
  const grid = new Map<number, number[]>();
  among.forEach((t, i) => {
    const key = standKey(Math.floor(t.x / cell), Math.floor(t.y / cell));
    const list = grid.get(key);
    if (list) list.push(i); else grid.set(key, [i]);
  });
  const crowd = new Float32Array(trees.length), openX = new Float32Array(trees.length), openY = new Float32Array(trees.length);
  trees.forEach((t, i) => {
    const cx = Math.floor(t.x / cell), cy = Math.floor(t.y / cell);
    let n = 0, ax = 0, ay = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(standKey(cx + dx, cy + dy)) ?? []) {
          const o = among[j]!;
          if (o === t) continue;
          const ex = o.x - t.x, ey = o.y - t.y;
          const d = Math.hypot(ex, ey);
          if (d > STAND_REACH || d < 1e-3) continue;
          const w = 1 - d / STAND_REACH;
          n += w; ax += (ex / d) * w; ay += (ey / d) * w;
        }
      }
    }
    crowd[i] = Math.min(1, n / 6);
    const a = Math.hypot(ax, ay);
    openX[i] = a > 1e-3 ? -ax / a : 0;
    openY[i] = a > 1e-3 ? -ay / a : 0;
  });
  return { crowd, openX, openY };
}

/** A tree's matrix, into `m` at `o`: deep in a wood taller and narrower */
export function treeMatrixInto(item: TreePlacement, crowd: number, openX: number, openY: number, m: { [i: number]: number }, o: number): void {
  const tall = item.size * (0.92 + 0.22 * crowd);
  const wide = item.size * (1.12 - 0.3 * crowd) * (0.94 + ((item.seed * 5.3) % 1) * 0.12);
  const lean = 0.22 * (1 - crowd) * Math.min(1, crowd * 4);
  const sx = openX * lean, sz = -openY * lean;
  const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
  m[o] = c * wide; m[o + 1] = 0; m[o + 2] = -s * wide; m[o + 3] = 0;
  m[o + 4] = sx * tall; m[o + 5] = tall; m[o + 6] = sz * tall; m[o + 7] = 0;
  m[o + 8] = s * wide; m[o + 9] = 0; m[o + 10] = c * wide; m[o + 11] = 0;
  m[o + 12] = item.x; m[o + 13] = item.z; m[o + 14] = -item.y; m[o + 15] = 1;
}

/** A tree's own green, into `col` at `o` (it multiplies the model's linear colours, three's color_vertex) */
export function treeColourInto(item: TreePlacement, col: { [i: number]: number }, o: number): void {
  const t = 0.9 + ((item.seed * 3.77) % 1) * 0.2;
  const hue = ((item.seed * 1.3) % 1) - 0.5;
  col[o] = t * (1 + hue * 0.16);
  col[o + 1] = t;
  col[o + 2] = t * (0.96 - hue * 0.12);
}

/** The trees, instanced per variety: one mesh each, the whole model at every distance. */
export function buildNatureForest(trees: readonly TreePlacement[], kit: NatureTreeKit, room: readonly number[] = forestRoom(trees, kit)): NatureForest {
  const varieties = kit.variants.length;
  const meshes: InstancedMesh[] = [];
  interface Group {
    readonly mesh: InstancedMesh;
    /** The variety's foliage cards: the same instances, written with the body's. */
    readonly cards: InstancedMesh | null;
    readonly capacity: number;
    count: number;
  }
  const groups: (Group | null)[] = kit.variants.map((variant, k) => {
    const capacity = Math.max(0, Math.floor(room[k] ?? 0));
    if (capacity === 0) return null;
    const mesh = new InstancedMesh(variant.levels[0], kit.material, capacity);
    mesh.name = `nature-tree-${TREE_MODELS[k] ?? k}-${k}`;
    mesh.castShadow = true;
    mesh.customDepthMaterial = kit.depth;
    // The upper leaves shading the lower is what gives a crown its depth.
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    // The tint per tree from the start: the program is built once with it.
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.count = 0;
    meshes.push(mesh);
    let cards: InstancedMesh | null = null;
    if (variant.cards) {
      cards = new InstancedMesh(variant.cards, kit.cardMaterial, capacity);
      cards.name = `nature-tree-${TREE_MODELS[k] ?? k}-${k}-cards`;
      // The crown's heart throws the tree's shadow; alpha-cut cards in the shadow pass cost far more than they add.
      cards.castShadow = TREE_MODELS[k] === 'palm';
      cards.customDepthMaterial = kit.cardDepth;
      cards.receiveShadow = false;
      cards.frustumCulled = false;
      // The same buffers as the body: one write places both.
      cards.instanceMatrix = mesh.instanceMatrix;
      cards.instanceColor = mesh.instanceColor;
      cards.count = 0;
      meshes.push(cards);
    }
    return { mesh, cards, capacity, count: 0 };
  });

  const place = (list: readonly TreePlacement[]): boolean => {
    const byVariety: number[][] = kit.variants.map(() => []);
    list.forEach((tree, i) => byVariety[varietyOf(tree, varieties)]!.push(i));
    if (byVariety.some((indices, k) => indices.length > (groups[k]?.capacity ?? 0))) return false;
    const stand = stands(list);
    groups.forEach((g, k) => {
      if (!g) return;
      const indices = byVariety[k]!;
      const m = g.mesh.instanceMatrix.array as Float32Array;
      const col = g.mesh.instanceColor!.array as Float32Array;
      indices.forEach((i, slot) => {
        const item = list[i]!;
        treeMatrixInto(item, stand.crowd[i]!, stand.openX[i]!, stand.openY[i]!, m, slot * 16);
        treeColourInto(item, col, slot * 3);
      });
      g.count = indices.length;
      g.mesh.count = g.count;
      if (g.cards) g.cards.count = g.count;
      // Only the instances drawn go to the GPU (`addUpdateRange`).
      if (g.count === 0) return;
      g.mesh.instanceMatrix.clearUpdateRanges();
      g.mesh.instanceMatrix.addUpdateRange(0, g.count * 16);
      g.mesh.instanceMatrix.needsUpdate = true;
      g.mesh.instanceColor!.clearUpdateRanges();
      g.mesh.instanceColor!.addUpdateRange(0, g.count * 3);
      g.mesh.instanceColor!.needsUpdate = true;
    });
    return true;
  };
  place(trees);
  let lastX = Infinity, lastY = Infinity, lastZ = Infinity;
  return {
    meshes,
    update: place,
    updateLod(x, y, z) {
      // One model at every distance: nothing to sort as the camera moves.
      if (Math.hypot(x - lastX, y - lastY, z - lastZ) < LOD_SLACK) return;
      lastX = x; lastY = y; lastZ = z;
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
