import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, layRun, onChartOf, toOwner } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';
import { barrierProblem, snapBarrierPoint } from '@editor/barriers';
import { PLANET_MAX_PIECE } from '@editor/planetFrame';

/**
 * A WALL ACROSS THE PIECES' BORDERS (`editor/barriers.ts`, `world/doc.ts`
 * barrierNear, `render/barriers.ts`). Run with `vitest.planet.config.ts`.
 *
 * A wall's clicks were kept each on its own piece's chart and every stretch
 * measured between them as they stood: a run across a border was a phantom
 * across the atlas (its footprint refused as on a road, or built as junk),
 * Shift-click found it nowhere near it, and a point by a road kept on the next
 * piece's chart never went onto its footway.
 */

for (const [where, chart, dir] of [
  ['on one face of the cube', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
  ['over an edge of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
] as const) {
  const c = tileCentre(chart);
  // Moved out as the border moved (`_border.ts`); the scenes in 0.4 m units, times U.
  const along = acrossBorders(chart, dir, 0);
  const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });

  describe(`a wall across the borders between pieces, ${where}`, () => {
    it('is built, and found by every stretch across a border', () => {
      const doc = new RoadDoc();
      const run = layRun([at(-100, 60), at(700, 60), at(1100, 60)], PLANET_MAX_PIECE);
      expect(new Set(run.map((p) => chartAt(p.x, p.y))).size).toBeGreaterThan(2);
      expect(barrierProblem(null, 'wall', run)).toBeNull();
      const wall = doc.addBarrier('wall', run)!;
      let across = 0;
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1]!, b = onChartOf(run[i]!, a);
        if (chartAt(run[i]!.x, run[i]!.y) === chartAt(a.x, a.y)) continue;
        across++;
        const mid = toOwner(chartAt(a.x, a.y), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + U });
        expect(doc.barrierNear(mid, 3 * U)?.id, `stretch ${i}`).toBe(wall.id);
      }
      expect(across).toBeGreaterThan(1);
    });

    it('goes onto the footway of a road kept on the next piece, and is not built over it', () => {
      const doc = new RoadDoc();
      doc.setBalance(1e9);
      const net = new Network(doc);
      net.rebuild();
      // A road along the line 600 to 1000 out, past borders.
      const a = at(600, 0), b = onChartOf(at(1000, 0), a);
      expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
        [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
      if (net.revision !== doc.revision) net.rebuild();
      // A click a little off the back of its footway, on every piece along it.
      for (const x of [650, 750, 850, 950]) {
        const near = at(x, 16);
        const snapped = snapBarrierPoint(net, 'wall', near);
        const q = onChartOf(snapped, near);
        expect(Math.hypot(q.x - near.x, q.y - near.y), `at ${x}`).toBeGreaterThan(0.01 * U);
        expect(Math.hypot(q.x - near.x, q.y - near.y), `at ${x}`).toBeLessThan(8 * U);
      }
      // A wall drawn down the middle of the road is refused.
      expect(barrierProblem(net, 'wall', layRun([at(620, 0), at(980, 0)], PLANET_MAX_PIECE))).toBe('road');
      // One beside it, past its footway, is built.
      expect(barrierProblem(net, 'wall', layRun([at(620, 40), at(980, 40)], PLANET_MAX_PIECE))).toBeNull();
    });
  });
}
