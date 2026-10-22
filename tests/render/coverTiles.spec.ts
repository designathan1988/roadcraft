import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { onCarriageway } from '@world/carriageway';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { PaintDab, PaintKind } from '@world/terrainPaint';
import { TILE, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { KEEP_CELL, keepCellKey, keepCellOf } from '@render/candidateKeep';
import { CellKeeps } from '@render/cellKeeps';
import { ClearingCells } from '@render/clearingCells';
import { type Candidate, type CoverField, forestIn, rocksIn, scrubIn } from '@render/coverSweep';
import type { CoverBake, CoverExtra } from '@render/coverTiles';
import { COVER_POSE, type TreePlacement } from '@render/groundCover';
import { type Run, RunBuilder } from '@render/instanceRuns';
import { TREE_POSE } from '@render/natureTrees';
import { coverInto, coverLayout, treesInto } from '@render/plantCells';
import { coverOf, geologyOf, layCover, plateCover } from '@render/coverRaster';
import { TERRAIN_HALF } from '@render/terrainGrid';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S PAINTED COVER BAKED IN A WORKER (`coverTiles.ts`): every tile's bake together is what the page's plates, keeps and cover cells make of the whole map */

/** Runs' instances as sorted rows. */
function rows(runs: readonly (Run | null)[], stride: number): string[] {
  const out: string[] = [];
  for (const run of runs) {
    for (const [store, pack] of run ?? []) {
      for (let i = 0; i < pack.count; i++) out.push([store, ...pack.data.subarray(i * stride, (i + 1) * stride), ...(pack.colours?.subarray(i * 3, i * 3 + 3) ?? []), pack.scales[i]!].map((v) => v.toFixed(3)).join(','));
    }
  }
  return out.sort();
}

describe('a tile\'s painted cover baked in a worker', () => {
  it('every tile\'s bake together is the page\'s stones, scrub and painted woods, a stroke over a tile\'s edge laid whole', async () => {
    const doc = new RoadDoc();
    // A road through the woods (nothing stands on it), and a clearing cut in them.
    doc.addSegment(doc.addNode({ x: -m(700), y: m(40) }).id, doc.addNode({ x: m(700), y: m(60) }).id, 1);
    const rng = new Rng(0xc0e7);
    const kinds: readonly PaintKind[] = ['forest', 'forest', 'scrub', 'rocks', 'sandstone', 'grass'];
    for (let k = 0; k < 160; k++) {
      // Strokes round the corner of four tiles.
      doc.addPaintDab({ kind: kinds[k % kinds.length]!, x: (rng.float() - 0.5) * m(500), y: (rng.float() - 0.5) * m(500), radius: m(20) + rng.float() * m(40), strength: 0.4 + rng.float() * 0.6 });
    }
    const clearings = [{ x: m(30), y: -m(60), radius: m(25) }];
    const net = new Network(doc);
    net.rebuild();
    const models = { rocks: 3, scrub: 2, trees: { broadleaf: 2, broadleafTall: 1, conifer: 2, ipeYellow: 1, ipePink: 1 } };
    const variants = 5;
    // The page's way: each plate's cover laid from every dab reaching it (by tile, each tile's in its order: `coverTiles.ts`); the keeps' tests; a cell's cover and its woods among the cells round it.
    const owners = [tileKey(-1, -1), tileKey(-1, 0), tileKey(0, -1), tileKey(0, 0)].sort((a, b) => a - b);
    const dabsByTile = owners.flatMap((key) => doc.tileRecords(key, 1).paint) as readonly PaintDab[];
    expect(dabsByTile.length).toBe(doc.terrainPaint.length);
    const plates = new Map<number, ReturnType<typeof plateCover> & { cx: number; cy: number }>();
    const plateAt = (x: number, y: number): ReturnType<typeof plateCover> & { cx: number; cy: number } => {
      const key = plateOf(x, y);
      let p = plates.get(key);
      if (!p) {
        const cx = Math.floor(x / PLATE_SIZE + 0.5) * PLATE_SIZE, cy = Math.floor(y / PLATE_SIZE + 0.5) * PLATE_SIZE;
        p = { ...plateCover(), cx, cy };
        for (const d of dabsByTile) if (Math.abs(d.x - cx) <= TERRAIN_HALF + d.radius && Math.abs(d.y - cy) <= TERRAIN_HALF + d.radius) layCover(p, { ...d, x: d.x - cx, y: d.y - cy });
        plates.set(key, p);
      }
      return p;
    };
    const field: CoverField = {
      forestAt: (x, y) => { const p = plateAt(x, y); return coverOf(p.covers, 'forest', x - p.cx, y - p.cy); },
      coverAt: (kind, x, y) => { const p = plateAt(x, y); return coverOf(p.covers, kind, x - p.cx, y - p.cy); },
      shoreLevelAt: () => null,
    };
    const cut = new ClearingCells();
    cut.follow(doc, clearings);
    const free = (c: Candidate): number | null => (onCarriageway(net, c) ? null : 0);
    const keeps = { forest: new CellKeeps<Candidate>((c) => (free(c) === null || cut.has(c.x, c.y) ? null : 0)), scrub: new CellKeeps<Candidate>(free), rocks: new CellKeeps<Candidate>(free) };
    const cells: number[] = [];
    for (let ci = -TILE / KEEP_CELL; ci < TILE / KEEP_CELL; ci++) for (let cj = -TILE / KEEP_CELL; cj < TILE / KEEP_CELL; cj++) cells.push(keepCellKey(ci, cj));
    for (const key of cells) { keeps.forest.fill(key, forestIn(key, field)); keeps.scrub.fill(key, scrubIn(key, field)); keeps.rocks.fill(key, rocksIn(key, field)); }
    const { layout, stores } = coverLayout(models.rocks, models.scrub, models.trees);
    const cover = new RunBuilder(Array.from({ length: stores }, () => ({ tinted: true })), COVER_POSE);
    const forest = new RunBuilder(Array.from({ length: variants }, () => ({ tinted: true })), TREE_POSE);
    const woods = (key: number): TreePlacement[] => keeps.forest.standingIn(key).map(({ c, z }) => ({ ...c, z }) as TreePlacement);
    for (const key of cells) {
      const rocks = keeps.rocks.standingIn(key).map(({ c, z }) => { const p = plateAt(c.x, c.y); return { x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed, rock: geologyOf(p.sand, p.basalt, c.x - p.cx, c.y - p.cy) }; });
      const scrub = keeps.scrub.standingIn(key).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed }));
      coverInto(cover, layout, rocks, scrub, []);
      const own = woods(key);
      if (!own.length) continue;
      const [i, j] = keepCellOf(key);
      const among: TreePlacement[] = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...woods(keepCellKey(i + di, j + dj)));
      treesInto(forest, own, among, variants);
    }
    const wantCover = rows([cover.build()], COVER_POSE.stride), wantForest = rows([forest.build()], TREE_POSE.stride);
    expect(wantCover.length).toBeGreaterThan(100);
    expect(wantForest.length).toBeGreaterThan(30);
    const extra: CoverExtra = { models, variants, standIns: false, clearings };
    const bakes = await bakeEveryTile(doc, [-TILE / 2, -TILE / 2, TILE / 2, TILE / 2], 'covers', extra, ['rest', 'roads', 'buildings']) as CoverBake[];
    expect(bakes.length).toBe(4);
    expect(rows(bakes.map((b) => b.cover), COVER_POSE.stride)).toEqual(wantCover);
    expect(rows(bakes.map((b) => b.forest), TREE_POSE.stride)).toEqual(wantForest);
  });
});
