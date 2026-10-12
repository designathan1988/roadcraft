import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { type TransitData, addTrack, longestOnRoad, nearestTrack, railGraph, railPath } from '@world/transit';
import { onCarriageway } from '@world/carriageway';
import { commitRoadPath } from '@editor/commit';
import { layTrack } from '@editor/transitTools';
import { PLANET_MAX_PIECE } from '@editor/planetFrame';

/**
 * A RAILWAY ACROSS THE PIECES' BORDERS (`world/transit.ts`,
 * `editor/transitTools.ts` layTrack). Run with `vitest.planet.config.ts`.
 *
 * A track's clicks were kept as they came, each on its own piece's chart:
 * a stretch from one piece to the next was measured between two charts'
 * points - 1 300 units apart in the atlas on one face of the cube, tens of km
 * and turned across an edge of it - a phantom the trains were routed over and
 * the station tool picked far away.
 */

const EMPTY: TransitData = { stops: [], tracks: [], lines: [], nextId: 1 };

for (const [where, chart, dir] of [
  ['on one face of the cube', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
  // West from the second piece of a face: over the cube's edge onto the next face.
  ['over an edge of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
] as const) {
  const c = tileCentre(chart);
  /** A point `x` along the line from `chart`'s piece (east, or west), kept on the chart of the piece it lies on. */
  // Moved out as the border moved (`_border.ts`).
  const along = acrossBorders(chart, dir, 0);
  const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });

  describe(`a railway across the borders between pieces, ${where}`, () => {
    const run = layTrack([-100, 500, 1400].map((x) => at(x, 30)));
    const data = addTrack(EMPTY, 'train', run).data;

    it('is laid in stretches no longer than a piece of road, each joining neighbours', () => {
      expect(new Set(run.map((p) => chartAt(p.x, p.y))).size).toBeGreaterThan(2);
      const g = railGraph(data, 'train');
      for (const e of g.edges) expect(e.length).toBeLessThanOrEqual(PLANET_MAX_PIECE + 1);
      // As long as it was drawn, give or take the charts' scale.
      const drawn = along(1400) - along(-100);
      const total = g.edges.reduce((sum, e) => sum + e.length, 0);
      expect(total).toBeGreaterThan(drawn - 10 * U);
      expect(total).toBeLessThan(drawn + 10 * U);
    });

    it('is found where it is, in the middle of every stretch across a border', () => {
      let across = 0;
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1]!, b = onChartOf(run[i]!, a);
        if (chartAt(run[i]!.x, run[i]!.y) === chartAt(a.x, a.y)) continue;
        across++;
        // Three units beside the stretch's middle, kept on the piece it lies on.
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const mid = { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * 3 * U, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * 3 * U };
        const on = nearestTrack(data, toOwner(chartAt(a.x, a.y), mid), 10 * U);
        expect(on, `stretch ${i}`).not.toBeNull();
        expect(on!.d).toBeLessThan(3.5 * U);
      }
      expect(across).toBeGreaterThan(1);
    });

    it('is followed end to end, the length it is', () => {
      const path = railPath(railGraph(data, 'train'), run[0]!, run[run.length - 1]!)!;
      expect(path).not.toBeNull();
      let length = 0;
      for (let i = 1; i < path.length; i++) {
        const b = onChartOf(path[i]!, path[i - 1]!);
        length += Math.hypot(b.x - path[i - 1]!.x, b.y - path[i - 1]!.y);
      }
      const drawn = along(1400) - along(-100);
      expect(length).toBeGreaterThan(drawn - 10 * U);
      expect(length).toBeLessThan(drawn + 10 * U);
    });

    it('crosses a road beyond a border as a level crossing, not down it', () => {
      const doc = new RoadDoc();
      doc.setBalance(1e9);
      const net = new Network(doc);
      net.rebuild();
      // A road across the railway's line, 900 along (past borders), drawn on its start's chart.
      const a = at(900, -200), b = onChartOf(at(900, 260), a);
      expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
        [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
      if (net.revision !== doc.revision) net.rebuild();
      const onRoad = longestOnRoad(run, (p) => onCarriageway(net, p));
      // It crosses the carriageway (some metres), and does not run down it.
      expect(onRoad).toBeGreaterThan(4);
      expect(onRoad).toBeLessThan(30);
    });
  });
}
