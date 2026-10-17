import { Color, type Frustum, Group, type Matrix4 } from 'three';
import { keepCellKey, keepCellOf } from './candidateKeep';
import { m } from '@world/units';

import { COVER_POSE, COVER_STANCE, FOREST_SPECIES, coverPoseInto, coverVariant, rockTint, scrubTint, treeTint, type CoverPlacement, type GroundCoverKit, type TreePlacement } from './groundCover';
import { createInstanceRuns, RunBuilder, type PoseFormat, type Run, type RunStore } from './instanceRuns';
import { TREE_MODELS, TREE_POSE, type NatureTreeKit, standsAmong, treeColourInto, treePoseInto, varietyOf } from './natureTrees';
import { PICTURE_PX } from './plantImpostors';

/** How far off the view a tree (up to 19 m tall) and a stone or bush still throw a shadow into it, low sun. */
const TREE_SHADOW_REACH = m(48);
const COVER_SHADOW_REACH = m(8);

/** DO NOT write every tree of the map into its meshes again when one changed (`NatureForest.update`, `buildGroundCover`) */
export interface PlantCells {
  readonly group: Group;
  /** The cells whose places changed (`CandidateKeep.takeChangedCells`) written again; null */
  sync(changed: ReadonlySet<number> | null, cells: Iterable<number>): void;
  cull(frustum: Frustum, view: Matrix4): void;
  /** The map zoom: the leaf cards left out (`InstanceRuns.setMap`). */
  setMap(map: boolean): void;
  /** A run made elsewhere (a tile's, baked in a worker: `plantedTiles.ts`) drawn with the cells' own; taken away by `take` with the same run. */
  put(run: Run): void;
  take(run: Run): void;
  dispose(): void;
}

/** A layer of cells, each a run made by `runOf`; `neighbourly`: a change of a cell writes its neighbours again too */
function plantLayer(name: string, stores: readonly RunStore[], format: PoseFormat, runOf: (cell: number, builder: RunBuilder) => void, neighbourly: boolean, margin: number): PlantCells {
  const runs = createInstanceRuns(name, stores, margin, format);
  const drawn = new Map<number, Run>();
  return {
    group: runs.group,
    sync(changed, cells) {
      const dirty = new Set<number>();
      if (changed === null) {
        /** @rebuild Every cell: a new sweep, or the models come. */
        for (const cell of drawn.keys()) dirty.add(cell);
        for (const cell of cells) dirty.add(cell);
      } else {
        for (const cell of changed) {
          if (!neighbourly) { dirty.add(cell); continue; }
          const [i, j] = keepCellOf(cell);
          for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) dirty.add(keepCellKey(i + di, j + dj));
        }
      }
      const removed: Run[] = [], added: Run[] = [];
      for (const cell of dirty) {
        const was = drawn.get(cell);
        if (was) { removed.push(was); drawn.delete(cell); }
        const builder = new RunBuilder(stores, format);
        runOf(cell, builder);
        const run = builder.build();
        if (run.size) { added.push(run); drawn.set(cell, run); }
      }
      if (removed.length || added.length) runs.update({ removed, added });
    },
    cull(frustum, view) { runs.cull(frustum, view); },
    setMap(map) { runs.setMap(map); },
    put(run) { runs.update({ removed: [], added: [run] }); },
    take(run) { runs.update({ removed: [run], added: [] }); },
    dispose() { runs.dispose(); drawn.clear(); },
  };
}

/** The trees of a cell and the cells round it (a tree's shape reads its neighbours). */
function treesRound(cell: number, treesIn: (cell: number) => TreePlacement[]): { readonly own: TreePlacement[]; readonly among: TreePlacement[] } {
  const own = treesIn(cell);
  if (!own.length) return { own, among: own };
  const [i, j] = keepCellOf(cell);
  const among: TreePlacement[] = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...(di === 0 && dj === 0 ? own : treesIn(keepCellKey(i + di, j + dj))));
  return { own, among };
}

/** The countryside's low-poly trees (`natureTrees.ts`), cell by cell: a body and its leaf cards near, its picture far (`plantImpostors.ts`). */
export function createTreeCells(kit: NatureTreeKit, name: string, treesIn: (cell: number) => TreePlacement[]): PlantCells {
  const far = kit.pictures;
  const stores: RunStore[] = kit.variants.map((variant, k) => ({
    name: `nature-tree-${TREE_MODELS[k] ?? k}-${k}`, geometry: variant.levels[0]!, material: kit.material, depth: kit.depth,
    // The upper leaves shading the lower is what gives a crown its depth.
    castShadow: true, receiveShadow: true, tinted: true, cards: false,
    levels: { reach: far.reach[k]!, far: PICTURE_PX, view: far.setView, ready: () => far.ready() },
    with: [
      ...(variant.cards ? [{
        name: `nature-tree-${TREE_MODELS[k] ?? k}-${k}-cards`, geometry: variant.cards, material: kit.cardMaterial, depth: kit.cardDepth,
        // The crown's heart throws the tree's shadow; a palm's few fronds are its crown, and throw it.
        castShadow: TREE_MODELS[k] === 'palm', receiveShadow: false, cards: true, far: false,
      }] : []),
      // Its picture takes no shadow, as its cards take none.
      { name: `nature-tree-${TREE_MODELS[k] ?? k}-${k}-far`, geometry: far.quads[k]!, material: far.material, depth: far.depth,
        castShadow: true, receiveShadow: false, cards: false, far: true, made: far.attach },
    ],
  }));
  return plantLayer(name, stores, TREE_POSE, (cell, builder) => {
    const { own, among } = treesRound(cell, treesIn);
    if (own.length) treesInto(builder, own, among, kit.variants.length);
  }, true, TREE_SHADOW_REACH);
}

/** A cell's trees put in a run of the woods' stores (`TREE_POSE`, a store a model): each shaped by the trees round it (`standsAmong`, `among` its cell's and its neighbours'), tinted, its model picked of `variants` (`varietyOf`); the page's cells and a tile's bake (`plantedTiles.ts`) alike. */
export function treesInto(builder: RunBuilder, own: readonly TreePlacement[], among: readonly TreePlacement[], variants: number): void {
  const pose = new Float32Array(TREE_POSE.stride), col = new Float32Array(3), tint = { r: 1, g: 1, b: 1 };
  const stand = standsAmong(own, among);
  own.forEach((tree, i) => {
    treePoseInto(tree, stand.crowd[i]!, stand.openX[i]!, stand.openY[i]!, pose, 0);
    treeColourInto(tree, col, 0);
    tint.r = col[0]!; tint.g = col[1]!; tint.b = col[2]!;
    builder.add(varietyOf(tree, variants), pose, tree.size * 1.2, tint);
  });
}

/** The painted covers' stones and bushes, the rivers' stones, and the woods' card trees where the low-poly ones are not grown. */
export function createCoverCells(kit: GroundCoverKit, name: string, places: {
  readonly rocksIn: (cell: number) => CoverPlacement[];
  readonly scrubIn: (cell: number) => CoverPlacement[];
  readonly treesIn: (cell: number) => TreePlacement[];
}): PlantCells {
  const stores: RunStore[] = [];
  const shown = (geometry: RunStore['geometry'], material: RunStore['material'], storeName: string, extra: Partial<RunStore> = {}): number =>
    stores.push({ name: storeName, geometry, material, castShadow: true, receiveShadow: true, tinted: true, cards: false, ...extra }) - 1;
  const rocks = kit.rocks.map((g) => shown(g, kit.rockMaterial, 'rocks'));
  const scrub = kit.scrub.map((g) => shown(g, kit.scrubMaterial, 'scrub'));
  const trees = Object.fromEntries(FOREST_SPECIES.map((species) => [species, kit.trees[species].map((model) => {
    const cards = model.cards && kit.trees[species].every((mm) => mm.cards) ? model.cards : null;
    // Its shadow sways with it (the forest's wind in the depth pass too).
    return shown(model.body, kit.treeMaterial, 'forest', {
      depth: kit.treeDepth,
      // DO NOT keep the cards as a store of their own: the same placements twice. Drawn from the body's instances; the crown's heart throws the shadow.
      with: cards ? [{ name: 'forest-cards', geometry: cards, material: kit.cardMaterial, castShadow: false, receiveShadow: false, cards: true, far: false }] : [],
    });
  })])) as Record<(typeof FOREST_SPECIES)[number], number[]>;
  const pose = new Float32Array(COVER_POSE.stride), colour = new Color(), tint = { r: 1, g: 1, b: 1 };
  const put = (builder: RunBuilder, store: number, item: CoverPlacement, stance: (typeof COVER_STANCE)[keyof typeof COVER_STANCE], paint: (item: CoverPlacement, out: Color) => Color): void => {
    coverPoseInto(item, stance.sink, stance.tilt, stance.upright, pose, 0);
    paint(item, colour);
    tint.r = colour.r; tint.g = colour.g; tint.b = colour.b;
    builder.add(store, pose, item.size, tint);
  };
  return plantLayer(name, stores, COVER_POSE, (cell, builder) => {
    for (const item of places.rocksIn(cell)) put(builder, rocks[coverVariant(item, rocks.length)]!, item, COVER_STANCE.rocks, rockTint);
    for (const item of places.scrubIn(cell)) put(builder, scrub[coverVariant(item, scrub.length)]!, item, COVER_STANCE.scrub, scrubTint);
    for (const tree of places.treesIn(cell)) {
      const models = trees[tree.species];
      if (!models?.length) continue;
      put(builder, models[coverVariant(tree, models.length)]!, tree, COVER_STANCE.trees, treeTint);
    }
  }, false, COVER_SHADOW_REACH);
}
