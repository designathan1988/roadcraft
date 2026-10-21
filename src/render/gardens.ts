import { Group, type BufferGeometry, type Color, type Frustum, type InstancedMesh, type Material, type Matrix4, type MeshDepthMaterial } from 'three';
import { Rng } from '@core/rng';
import { followPieces } from '@world/buildings/elements';
import { localToWorld } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import type { BuildingStore } from '@world/buildings/store';
import type { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import { createCellInstances, type KindSpec, type Pack } from './cellInstances';
import { NEVER_NEAR, YAW_POSE } from './instanceRuns';
import { PICTURE_PX, sceneryPictures, type SceneryPictures } from './plantImpostors';
import { createPropLayer, type PropLayer } from './propCells';
import { BUSH_KINDS, TREE_SPECIES, type TreeSpecies } from './propGeometry';
import { SHADOW_REACH, foliageTint, type Scenery, type SceneryKit } from './scenery';

/** DO NOT go back to rebuilding the whole town's gardens at every building. */

/** A plant of a building's garden, in the world: a tree, a shrub, a run of hedge or a flower bed. */
export interface GardenPlant {
  readonly kind: 'tree' | 'shrub' | 'hedge' | 'flowers';
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Size, world units: along (w), across (d) and height (h); `yaw` the way `w` runs. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly seed: number;
  /** A tree's species, when it is not a garden's mix (a painted forest's). */
  readonly species?: TreeSpecies;
  /** A shrub that never flowers (a wood's understorey). */
  readonly plain?: boolean;
}

/** The plants of every building's garden, in the world, on the ground they stand on. */
export function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      // A long hedge in steps, each on the ground under it, not one box at its middle's height.
      const kind = el.kind;
      followPieces(el).forEach((piece, k) => {
        const at = localToWorld(b, piece.x, piece.y);
        out.push({ kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: piece.w, d: piece.d, h: piece.h, yaw,
          seed: ((b.id * 7919 + el.id * 104729 + k * 31) % 100003) / 100003 });
      });
    }
  }
  return out;
}

interface Placement { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; tint?: Color }

/** A garden tree's species: mostly broadleaf, some conifers, now and then a flowering ipê. */
function gardenSpecies(roll: number): TreeSpecies {
  if (roll < 0.42) return 'broadleaf';
  if (roll < 0.62) return 'broadleafTall';
  if (roll < 0.8) return 'conifer';
  return roll < 0.9 ? 'ipeYellow' : 'ipePink';
}

/** Floats a plant's pose takes (`YAW_POSE`): its place in the scene's frame (x, y, z), its yaw and its scale on three axes. */
const POSE = YAW_POSE.stride;

/** The kinds of plant, in the order of the gardens' kinds: the trees by species, then the bushes. */
const KIND_KEYS = [...TREE_SPECIES.map((s) => `tree:${s}`), ...BUSH_KINDS.map((k) => `bush:${k}`)];
const KIND_OF = new Map(KIND_KEYS.map((key, i) => [key, i]));

/** One garden's plants placed, by plant kind (`KIND_KEYS`): each one's pose (DO NOT keep 16-float matrices of every plant of the town), tint and largest scale. */
export function gardenPack(list: readonly GardenPlant[]): ReadonlyMap<number, Pack> {
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<string, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  for (const p of list) {
    const rng = new Rng(Math.floor(p.seed * 0xffffff) ^ 0x5eed);
    switch (p.kind) {
      case 'tree': {
        const spread = 0.82 + rng.float() * 0.3;
        const roll = rng.float();
        (trees.get(p.species ?? gardenSpecies(roll)) as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: p.h * spread, sy: p.h, sz: p.h * spread * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        // The geometry is about 1.5 across for 1 tall, kept in the bush's own proportions
        const across = (Math.min(p.w, p.d) / 1.5) * 0.8;
        const tall = Math.min(p.h, across * 1.3);
        const wide = Math.max(across, tall / 1.3);
        (bushes.get(!p.plain && rng.float() < 0.25 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: wide, sy: tall, sz: wide * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'hedge': {
        // Clipped pieces along its run, overlapping so it reads as one.
        const n = Math.max(1, Math.round(p.w / Math.max(m(2.2), p.h * 1.5)));
        const step = p.w / n;
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        const tint = foliageTint(rng);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step - p.w / 2;
          (bushes.get('hedge') as Placement[]).push({
            x: p.x + cx * t, y: p.y + cy * t, z: p.z - m(0.05), yaw: p.yaw,
            sx: (step / 1.9) * 1.25, sy: p.h, sz: p.d / 0.9, tint,
          });
        }
        break;
      }
      case 'flowers': {
        // A bed of low flowering clumps.
        const n = Math.max(2, Math.round((p.w * p.d) / (m(0.7) * m(0.7))));
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        for (let i = 0; i < Math.min(n, 24); i++) {
          const u = (rng.float() - 0.5) * p.w * 0.85, v = (rng.float() - 0.5) * p.d * 0.85;
          const h = m(0.35) + rng.float() * m(0.25);
          (bushes.get('bushFlowering') as Placement[]).push({
            x: p.x + cx * u - cy * v, y: p.y + cy * u + cx * v, z: p.z + m(0.12), yaw: rng.float() * Math.PI * 2,
            sx: h * 1.1, sy: h, sz: h * 1.1,
          });
        }
        break;
      }
    }
  }
  const out = new Map<number, Pack>();
  const pack = (key: string, placed: readonly Placement[]): void => {
    if (!placed.length) return;
    const poses = new Float32Array(placed.length * POSE);
    const scales = new Float32Array(placed.length);
    let colours: Float32Array | null = null;
    placed.forEach((placement, index) => {
      const at = index * POSE;
      poses[at] = placement.x; poses[at + 1] = placement.z; poses[at + 2] = -placement.y; poses[at + 3] = placement.yaw;
      poses[at + 4] = placement.sx; poses[at + 5] = placement.sy; poses[at + 6] = placement.sz;
      poses[at + 7] = NEVER_NEAR;
      scales[index] = Math.max(placement.sx, placement.sy, placement.sz);
      if (placement.tint) {
        colours ??= new Float32Array(placed.length * 3).fill(1);
        placement.tint.toArray(colours, index * 3);
      }
    });
    out.set(KIND_OF.get(key)!, { data: poses, colours, scales, count: placed.length });
  };
  for (const [species, placed] of trees) pack(`tree:${species}`, placed);
  for (const [kind, placed] of bushes) pack(`bush:${kind}`, placed);
  return out;
}

/** The buildings' garden lists to place and to take away (`gardenLists.ts`): a list is placed once and taken away by the same object. */
export interface GardenChange {
  readonly added: readonly (readonly GardenPlant[])[];
  readonly removed: readonly (readonly GardenPlant[])[];
}

export interface Gardens extends Scenery {
  /** DO NOT hand it the town's lists to find what changed: that was a pass over the town per building grown. */
  update(change: GardenChange): { readonly removed: readonly InstancedMesh[]; readonly added: readonly InstancedMesh[] };
}

/** The gardens' kinds (`KIND_KEYS`): each plant's body and leaf cards near, its picture far, chosen by its size on the screen. */
function gardenKinds(kit: SceneryKit, pictures: SceneryPictures): KindSpec[] {
  const far = pictures.set;
  /** A plant kind: its body and its leaf cards near, its picture far (`plantImpostors.ts`), chosen by its size on the screen. */
  const kind = (name: string, body: BufferGeometry, material: Material, depth: MeshDepthMaterial, cards: BufferGeometry | undefined,
    cardMaterial: Material, cardDepth: MeshDepthMaterial, picture: number): KindSpec => ({
    tinted: true,
    levels: { reach: far.reach[picture]!, far: PICTURE_PX, view: far.setView, ready: () => far.ready() },
    meshes: [
      { name, geometry: body, material, depth, castShadow: true, receiveShadow: true, cards: false, far: false },
      // The foliage cards: they throw no shadow (the crown's heart does).
      ...(cards ? [{ name: `${name}-cards`, geometry: cards, material: cardMaterial, depth: cardDepth, castShadow: false, receiveShadow: true, cards: true, far: false }] : []),
      { name: `${name}-far`, geometry: far.quads[picture]!, material: far.material, depth: far.depth, castShadow: true, receiveShadow: true, cards: false, far: true, made: far.attach },
    ],
  });
  return [
    ...TREE_SPECIES.map((s) => kind(`garden-trees-${s}`, kit.trees[s], kit.foliage, kit.foliageDepth, kit.cards[s], kit.treeCards, kit.treeCardsDepth, pictures.treeAt(s))),
    ...BUSH_KINDS.map((k) => kind(`garden-bushes-${k}`, kit.bushes[k], kit.shrubs, kit.shrubsDepth, kit.cards[k], kit.shrubCards, kit.shrubCardsDepth, pictures.bushAt(k))),
  ];
}

/** Each garden kind's picture among the scenery's (`KIND_KEYS` order). */
const gardenPictures = (pictures: SceneryPictures): number[] => [...TREE_SPECIES.map((s) => pictures.treeAt(s)), ...BUSH_KINDS.map((k) => pictures.bushAt(k))];

/** Every building's garden in one layer, given its lists (`gardenLists.ts`): what a test of the whole map places to compare. */
export function createGardens(kit: SceneryKit): Gardens {
  const pictures = sceneryPictures(kit);
  const kinds = gardenKinds(kit, pictures);
  // A plant's pose (`YAW_POSE`) goes to the GPU as it is, for a plant drawn at a new position; the vertex shader makes its matrix.
  const cells = createCellInstances(kinds, YAW_POSE, SHADOW_REACH);
  return {
    get meshes() { return cells.meshes; },
    grass: new Group(),
    get triangles() { return cells.triangles; },
    update(change) {
      // Only the gardens that came and went are read; each new one placed once for this update and let go after (the kinds hold them).
      const added = cells.update({ removed: change.removed, added: change.added.map((list) => ({ key: list, packs: gardenPack(list) })) });
      return { removed: [], added };
    },
    // A plant's level follows its size on the screen (`cellInstances.ts`).
    setNear() {},
    /** DO NOT drop the cull here unconditionally */
    setMap(map) { cells.setMap(map); },
    cull(frustum, view) { cells.cull(frustum, view); },
    exclude() { /* a garden's plants are the building's own */ },
    dispose() {
      cells.dispose();
      pictures.release();
    },
  };
}

/** The plants of the gardens standing about a rectangle (at least every one in it): the buildings whose bounds (their elements' too) meet it, each one's garden placed. */
export function gardenPacksAbout(buildings: BuildingStore, groundAt: (x: number, y: number) => number, rect: readonly [number, number, number, number]): ReadonlyMap<number, Pack> {
  const list: GardenPlant[] = [];
  // A building's bounds hold its garden's elements (`buildingBounds`): a plant stands within them.
  for (const b of buildings.near(rect[0] - GARDEN_SLACK, rect[1] - GARDEN_SLACK, rect[2] + GARDEN_SLACK, rect[3] + GARDEN_SLACK)) {
    for (const plant of gardenPlants([b], groundAt)) list.push(plant);
  }
  return gardenPack(list);
}

/** How far past a building's bounds its garden's placings may stand: a hedge's clipped piece, a flower bed's clump (both within its element, rounded). */
const GARDEN_SLACK = m(2);

/** THE GARDENS HELD ROUND THE VIEW (`propCells.ts`): placed cell by cell from the buildings of the document, near whole, far as their pictures. */
export interface GardenCells {
  readonly layer: PropLayer;
  readonly meshes: readonly InstancedMesh[];
  readonly triangles: number;
  /** The buildings and the ground the gardens are placed from: the cells placed from another store all dropped. */
  source(buildings: BuildingStore, groundAt: (x: number, y: number) => number): void;
  /** The diary's changes of the buildings and the ground since the last look (when the ground is settled: a stroke over). */
  follow(journal: ChangeJournal): void;
  setMap(map: boolean): void;
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

export function createGardenCells(kit: SceneryKit): GardenCells {
  const pictures = sceneryPictures(kit);
  let from: { buildings: BuildingStore; groundAt: (x: number, y: number) => number } | null = null;
  const layer = createPropLayer({
    name: 'gardens', version: 1, kinds: gardenKinds(kit, pictures), margin: SHADOW_REACH,
    // What a garden's place reads: its building, and the ground under each plant (`gardenLists.ts` read the same).
    changes: ['buildings', 'elevation', 'ground'], pad: GARDEN_SLACK,
    pictures: pictures.set, pictureOf: gardenPictures(pictures),
    place: (rect) => ({ packs: from ? gardenPacksAbout(from.buildings, from.groundAt, rect) : new Map(), growing: false }),
  });
  return {
    layer,
    get meshes() { return layer.meshes; },
    get triangles() { return layer.triangles; },
    source(buildings, groundAt) {
      if (from?.buildings === buildings && from.groundAt === groundAt) return;
      const again = from !== null;
      from = { buildings, groundAt };
      if (again) { layer.near.clear(); for (const f of layer.far) f.clear(); }
    },
    follow(journal) { layer.follow(journal); },
    setMap(map) { layer.setMap(map); },
    cull(frustum, view) { layer.cull(frustum, view); },
    dispose() {
      layer.dispose();
      pictures.release();
    },
  };
}
