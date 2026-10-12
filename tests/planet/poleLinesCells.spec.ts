import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { onChartOf, toOwner } from '@world/planet/charts';
import { insideMulti, onFootway, poleLines, poleLinesAt } from '@world/poleLines';
import { commitRoadPath } from '@editor/commit';

/**
 * THE POLE LINES BY CELL OVER THE PIECES' BORDERS (docs/PROBLEMAS.md P7.7):
 * a street kept as pieces on their own charts reaches a cell by its ghost
 * image (`withGhostImages`); the cell's lines (`poleLinesIn`, read from the
 * cells round it on its own chart AND on each neighbour's) must say there
 * what the whole map's lines say. Run with `vitest.planet.config.ts`.
 */
for (const [where, chart, dir] of [
  ['on one face of the cube', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
  ['over an edge of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
] as const) {
  const c = tileCentre(chart);
  const along = acrossBorders(chart, dir, 0);
  const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });

  describe(`pole lines by cell across the borders, ${where}`, () => {
    it('answer as the whole map\'s lines do along the street', () => {
      const doc = new RoadDoc();
      doc.setBalance(1e9);
      const net = new Network(doc);
      net.rebuild();
      const a = at(-100, 0), b = onChartOf(at(1100, 0), a);
      expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
        [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
      if (net.revision !== doc.revision) net.rebuild();
      const whole = poleLines(net);
      let footway = 0, compared = 0;
      for (let x = -90; x <= 1090; x += 7.3) {
        for (let y = -14; y <= 14; y += 0.9) {
          const p = at(x, y);
          const inWhole = insideMulti(p, whole.paving) && !insideMulti(p, whole.kerbed);
          expect(onFootway(net, p), `footway at ${x},${y}`).toBe(inWhole);
          if (inWhole) footway++;
          const near = (lines: typeof whole): number => Math.min(Infinity, ...lines.contours.map((l) => l.distanceTo(p)));
          const d = near(poleLinesAt(net, p)), dw = near(whole);
          // Within the kerb line's own working precision (Clipper at 3 decimals,
          // `poleLines.ts`): over the cube's edge a ghost image is carried from
          // another chart and comes back some micrometres off.
          if (dw < 12 * U) { expect(Math.abs(d - dw)).toBeLessThan(0.001); compared++; }
        }
      }
      expect(footway).toBeGreaterThan(100);
      expect(compared).toBeGreaterThan(200);
    });
  });
}
