import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { onCarriageway } from '@world/carriageway';
import { tileBuildingsOf } from '@world/growth/grownRows';
import type { PlantedTree } from '@world/trees';
import { m } from '@world/units';
import { createCoverIndex } from './buildings/layerCells';
import { keepCellKey, keepCellOf } from './candidateKeep';
import { keepCellAt } from './cellKeeps';
import type { TreePlacement } from './groundCover';
import { type Run, RunBuilder } from './instanceRuns';
import { TREE_POSE } from './natureTrees';
import type { NearBaker, NearProduct } from './nearTileBake';
import { type PlantCells, treesInto } from './plantCells';
import { runBuffers } from './streetFurnitureLayer';

/** THE TREES THE PLAYER PLANTED, A TILE AT A TIME, AS A NEAR PRODUCT (`nearTiles.ts`): which stand (off the carriageway, out of the buildings), on the ground as drawn, shaped by the trees round each (`standsAmong`), baked in a worker as the page's planted forest makes them (`plantCells.ts` createTreeCells), drawn in that forest's cells */

/** What a planted-tree bake reads from the page: how many models the woods' kit has (`varietyOf`). */
export interface PlantedExtra {
  readonly variants: number;
}

/** A tile's planted trees as a bake hands them: their instances in one run of the forest's stores. */
export interface PlantedBake {
  readonly run: Run;
}

/** THE TILE'S OWN PLANTED TREES (each in the tile it stands in), standing where the page's keep lets them (`renderer.ts` plantedKeeps: off the roads, out of the buildings of the 3 x 3 read), cell by cell among the standing trees of the cells round it (its neighbours' too) */
export const plantedBaker: NearBaker<PlantedBake | null, PlantedExtra> = {
  parts: ['rest'],
  // The roads and the buildings of a tile with trees only.
  more: ['roads', 'buildings'],
  has: (tiles) => tiles[0]!.trees.length > 0,
  around: true,
  // A tree stands on the ground as drawn at its foot.
  groundReach: m(8),
  bake(area, extra) {
    const net = area.net();
    const buildings: Building[] = [];
    for (const records of area.tiles) {
      for (const raw of tileBuildingsOf(records)) { const b = migrateBuilding(raw); if (b) buildings.push(b); }
    }
    const cover = createCoverIndex();
    cover.index(buildings);
    /** Each keep cell's standing trees, the tile's and its neighbours', and the tile's own. */
    const standing = new Map<number, TreePlacement[]>(), own = new Map<number, TreePlacement[]>();
    for (const records of area.tiles) {
      for (const t of records.trees as readonly PlantedTree[]) {
        if (onCarriageway(net, t) || cover.covers(t.x, t.y)) continue;
        const key = keepCellAt(t.x, t.y);
        const tree: TreePlacement = { x: t.x, y: t.y, z: area.groundAt(t.x, t.y), size: t.height, yaw: t.yaw, seed: t.seed, species: 'broadleaf' };
        for (const map of records === area.tile ? [standing, own] : [standing]) {
          const list = map.get(key);
          if (list) list.push(tree); else map.set(key, [tree]);
        }
      }
    }
    const builder = new RunBuilder(Array.from({ length: extra.variants }, () => ({ tinted: true })), TREE_POSE);
    for (const [key, mine] of [...own].sort((p, q) => p[0] - q[0])) {
      const [i, j] = keepCellOf(key);
      const among: TreePlacement[] = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...(standing.get(keepCellKey(i + di, j + dj)) ?? []));
      treesInto(builder, mine, among, extra.variants);
    }
    const run = builder.build();
    return run.size ? { run } : null;
  },
  buffers: (bake) => (bake ? runBuffers(bake.run) : []),
};

/** A tile's planted trees as the page draws them: their run put in the planted forest's cells (made with the woods' models, `forest`). */
export function plantedProduct(forest: () => PlantCells | null, variants: () => number): NearProduct<PlantedBake> {
  return {
    kind: 'planted',
    // A grown tree, a few metres across, seen as its picture from afar (`plantImpostors.ts`).
    cover: m(5) * m(5),
    top: m(20),
    enabled: () => forest() !== null,
    extra: (): PlantedExtra => ({ variants: variants() }),
    version: () => String(variants()),
    land(bake) {
      const layer = forest()!;
      return { put: () => layer.put(bake.run), remove: () => layer.take(bake.run) };
    },
  };
}
