import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { Network } from '@world/network';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { onCarriageway } from '@world/carriageway';
import type { PlantedTree } from '@world/trees';
import { m } from '@world/units';
import { keepCellKey, keepCellOf } from '@render/candidateKeep';
import { CellKeeps, keepCellAt } from '@render/cellKeeps';
import type { TreePlacement } from '@render/groundCover';
import { type Run, RunBuilder } from '@render/instanceRuns';
import { TREE_POSE } from '@render/natureTrees';
import { treesInto } from '@render/plantCells';
import type { PlantedBake } from '@render/plantedTiles';
import { bakeEveryTile } from '../support/nearTileBakes';

/** THE TREES THE PLAYER PLANTED, BAKED A TILE AT A TIME IN A WORKER (`plantedTiles.ts`): every tile's bake together is what the page's keep and forest make of the whole map */

/** A run's instances as sorted rows. */
function rows(runs: readonly Run[]): string[] {
  const out: string[] = [];
  for (const run of runs) {
    for (const [store, pack] of run) {
      for (let i = 0; i < pack.count; i++) {
        out.push([store, ...pack.data.subarray(i * TREE_POSE.stride, (i + 1) * TREE_POSE.stride), ...(pack.colours?.subarray(i * 3, i * 3 + 3) ?? []), pack.scales[i]!]
          .map((v) => v.toFixed(3)).join(','));
      }
    }
  }
  return out.sort();
}

describe('the planted trees baked a tile at a time', () => {
  it('every tile\'s bake together is the page\'s planted forest: the same trees standing, each shaped by the same trees round it', async () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
    const net = new Network(doc);
    net.rebuild();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    // Groves over the town, some on the streets (they do not stand), many across a tile's edge.
    const rng = new Rng(0x72ee);
    const trees: PlantedTree[] = [];
    for (let g = 0; g < 40; g++) {
      const cx = x0 + rng.float() * (x1 - x0), cy = y0 + rng.float() * (y1 - y0);
      for (let k = 0; k < 12; k++) trees.push({ x: cx + (rng.float() - 0.5) * m(90), y: cy + (rng.float() - 0.5) * m(90), height: m(6) + rng.float() * m(10), yaw: rng.float() * 6.28, seed: rng.float() });
    }
    doc.plantTrees(trees);
    const variants = 7;
    // The page's way (`renderer.ts` plantedKeeps, `plantCells.ts` createTreeCells): every tree filed by its keep cell, those off the carriageway standing, each cell among its neighbours.
    const keeps = new CellKeeps<PlantedTree>((t) => (onCarriageway(net, t) ? null : 0));
    const byCell = new Map<number, PlantedTree[]>();
    for (const t of doc.trees) { const key = keepCellAt(t.x, t.y); byCell.set(key, [...(byCell.get(key) ?? []), t]); }
    for (const [key, list] of byCell) keeps.fill(key, list);
    const placed = (cell: number): TreePlacement[] => keeps.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' }));
    const page = new RunBuilder(Array.from({ length: variants }, () => ({ tinted: true })), TREE_POSE);
    for (const cell of keeps.cellKeys()) {
      const own = placed(cell);
      if (!own.length) continue;
      const [i, j] = keepCellOf(cell);
      const among: TreePlacement[] = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...placed(keepCellKey(i + di, j + dj)));
      treesInto(page, own, among, variants);
    }
    const want = rows([page.build()]);
    expect(want.length).toBeGreaterThan(300);
    expect(want.length).toBeLessThan(trees.length);
    const bakes = await bakeEveryTile(doc, [x0 - m(100), y0 - m(100), x1 + m(100), y1 + m(100)], 'planted', { variants }, ['rest', 'roads', 'buildings']) as PlantedBake[];
    expect(bakes.length).toBeGreaterThan(1);
    expect(rows(bakes.map((b) => b.run))).toEqual(want);
  });
});
