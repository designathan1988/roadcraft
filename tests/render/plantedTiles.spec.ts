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
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { TILE, tileKey } from '@world/tiles';
import { createCoverIndex } from '@render/buildings/layerCells';
import { type BuildingStage, STAGE_FORMAT, stageKey } from '@render/nearBuildings';
import { partsDigest } from '@render/nearContent';
import type { NearTileCache } from '@render/nearTileBake';
import { runNearJob } from '@render/nearBakers';
import { recordsFor } from '@render/nearTiles';

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

  it('leaves out the trees under the buildings as the page\'s cover index does, the buildings read off each tile\'s kept stage', async () => {
    const doc = new RoadDoc();
    const rng = new Rng(0xb0d1);
    // Buildings round the corner of four tiles, a tree at and round each.
    for (let k = 0; k < 24; k++) {
      const bp = BLUEPRINTS[k % BLUEPRINTS.length]!;
      const x = (rng.float() - 0.5) * TILE, y = (rng.float() - 0.5) * TILE;
      doc.buildings.add({ ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: rng.float() * 3 } as Omit<Building, 'id'>);
      doc.plantTrees(Array.from({ length: 6 }, (_, q) => ({ x: x + (q - 2.5) * m(6), y: y + (q % 2) * m(5), height: m(8), yaw: 0, seed: rng.float() })));
    }
    const net = new Network(doc);
    net.rebuild();
    const variants = 4;
    const cover = createCoverIndex();
    cover.index(doc.buildings.all());
    const keeps = new CellKeeps<PlantedTree>((t) => (onCarriageway(net, t) || cover.covers(t.x, t.y) ? null : 0));
    const byCell = new Map<number, PlantedTree[]>();
    for (const t of doc.trees) { const key = keepCellAt(t.x, t.y); byCell.set(key, [...(byCell.get(key) ?? []), t]); }
    for (const [key, list] of byCell) keeps.fill(key, list);
    const placed = (cell: number): TreePlacement[] => keeps.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' }));
    const page = new RunBuilder(Array.from({ length: variants }, () => ({ tinted: true })), TREE_POSE);
    let standing = 0;
    for (const cell of keeps.cellKeys()) {
      const own = placed(cell);
      standing += own.length;
      if (!own.length) continue;
      const [i, j] = keepCellOf(cell);
      const among: TreePlacement[] = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...placed(keepCellKey(i + di, j + dj)));
      treesInto(page, own, among, variants);
    }
    expect(standing).toBeGreaterThan(20);
    expect(standing).toBeLessThan(doc.trees.length);
    const bakes = await bakeEveryTile(doc, [-TILE / 2, -TILE / 2, TILE / 2, TILE / 2], 'planted', { variants }, ['rest', 'roads', 'buildings']) as PlantedBake[];
    expect(rows(bakes.map((b) => b.run))).toEqual(rows([page.build()]));
  });

  it('reads a tile\'s buildings off the stage kept for them, never making them again from their rows', async () => {
    const doc = new RoadDoc();
    doc.buildings.add({ ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), x: m(500), y: m(500), rotation: 0 } as Omit<Building, 'id'>);
    doc.plantTrees([{ x: m(100), y: m(100), height: m(8), yaw: 0, seed: 0.3 }, { x: m(900), y: m(300), height: m(9), yaw: 1, seed: 0.6 }]);
    const tiles = [tileKey(0, 0)];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) tiles.push(tileKey(di, dj));
    const records = tiles.map((key) => doc.tileRecords(key, 1));
    // The stages kept: the tile's says its whole square is under a building (what its maker would keep for a building there).
    const kept = new Map<string, unknown>();
    for (const r of records) {
      const whole = r.key === tileKey(0, 0) ? [4, 0, 0, TILE, 0, TILE, TILE, 0, TILE] : [];
      kept.set(stageKey('p:', r.key), { format: STAGE_FORMAT, version: 1, content: partsDigest(r, ['buildings']), covers: Float64Array.from(whole), plants: new Float64Array(0) } satisfies BuildingStage);
    }
    const cache: NearTileCache = { ready: async () => true, get: async (key) => kept.get(key), put: async (key, value) => { kept.set(key, value); } };
    const reply = await runNearJob({
      node: '0,0', prefix: 'p:', heavy: true, ground: { ground: null, naturalIsGround: true },
      asks: [{ kind: 'planted', sig: 's', want: 'w', shown: null, extra: { variants: 3 } }],
      tiles: tiles.map((key) => ({ key, version: 1 })), records: records.map((r) => recordsFor(r, ['rest', 'roads', 'buildings'])),
    }, cache);
    // Every tree under the kept stage's cover: nothing stands. A bake that made the buildings again would find one building and two trees standing.
    expect(reply).toMatchObject({ kind: 'near', answers: [{ kind: 'planted', payload: null }] });
  });
});

