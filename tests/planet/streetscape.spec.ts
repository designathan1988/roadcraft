import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { snapLandscape, landscapeNear } from '@world/landscape';
import { streetFurniture } from '@world/streetFurniture';
import { commitRoadPath } from '@editor/commit';

/**
 * STREET FURNITURE ALONG A ROAD ACROSS THE PIECES' BORDERS
 * (`world/landscape.ts`, `world/streetFurniture.ts`). Run with
 * `vitest.planet.config.ts`.
 *
 * A road's ribbon is kept on its segment's chart, and a click on its footway
 * on the next piece was read against it as it stood: "offFootway" on that
 * part of every road, a bench turned a quarter round across an edge of the
 * cube, and an item no longer found on its footway after an edit.
 */

for (const [where, chart, dir] of [
  ['on one face of the cube', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
  ['over an edge of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
] as const) {
  const c = tileCentre(chart);
  // Moved out as the border moved (`_border.ts`).
  const along = acrossBorders(chart, dir, 0);
  const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });

  describe(`benches along a road across the borders, ${where}`, () => {
    it('are put on its footway on every piece, stand along it, and are found again', () => {
      const doc = new RoadDoc();
      doc.setBalance(1e9);
      const net = new Network(doc);
      net.rebuild();
      const a = at(-100, 0), b = onChartOf(at(1100, 0), a);
      expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
        [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
      if (net.revision !== doc.revision) net.rebuild();
      const charts = new Set<number>();
      for (let x = 0; x <= 1000; x += 50) {
        // A click on the footway, a little off the road's side, kept on the piece it lies on.
        const click = at(x, 13);
        const snap = snapLandscape(net, doc.landscape.values(), 'bench', click, 8 * U);
        expect(snap.ok, `at ${x}: ${snap.ok ? '' : snap.reason}`).toBe(true);
        const item = doc.addLandscape('bench', snap.at);
        charts.add(chartAt(item.x, item.y));
        // Picked again where it is.
        expect(landscapeNear(doc.landscape.values(), click, 10 * U)?.id).toBe(item.id);
      }
      expect(charts.size).toBeGreaterThan(2);
      const furniture = streetFurniture(net);
      expect(furniture.length).toBe(doc.landscape.size);
      // Each stands along the road, as the road runs on its own chart.
      for (const f of furniture) {
        const p = { x: f.x, y: f.y };
        const ahead = onChartOf(at(1100, 0), p), back = onChartOf(at(-100, 0), p);
        const l = Math.hypot(ahead.x - back.x, ahead.y - back.y);
        const along = Math.abs((f.along.x * (ahead.x - back.x) + f.along.y * (ahead.y - back.y)) / l);
        expect(along, `bench at chart ${chartAt(f.x, f.y)}`).toBeGreaterThan(0.99);
      }
    });
  });
}
