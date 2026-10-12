import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { COUNT_BUDGETS, withinBudget } from '@core/perfBudget';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { onChartOf, toOwner } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';

/**
 * THE PERFORMANCE BUDGETS ON THE PLANET, COUNTED (`core/perfBudget.ts`): a
 * network on three pieces' charts, one on another face of the cube -
 * kilometres apart in the atlas, as the player's map is. Its crossing surface
 * is filed in a grid per cluster of rings; one grid over the atlas between
 * them was 3.3 million cells a grid on the player's map (PL29). Run with
 * `vitest.planet.config.ts` (`npm run check`).
 */

describe('performance budgets on the planet, counted', () => {
  it('files a network over three charts in small grids', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const charts = [
      [2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
      [3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
      [0 * TILES_PER_SIDE * TILES_PER_SIDE + 3 * TILES_PER_SIDE + 2, 1],
    ] as const;
    for (const [chart, dir] of charts) {
      const c = tileCentre(chart), along = acrossBorders(chart, dir, 0);
      const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });
      const a = at(-100, 0), b = onChartOf(at(1100, 0), a);
      expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
        [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
      if (net.revision !== doc.revision) net.rebuild();
    }
    const perSegment = net.crossingSurface().cells / doc.segments.size;
    const budget = COUNT_BUDGETS.planetWalkableCellsPerSegment;
    expect(withinBudget(perSegment, budget), `células por segmento = ${perSegment.toFixed(1)} (orçamento ${budget.max}: ${budget.why})`).toBe(true);
  });
});
