import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { buildWalkways } from '@world/walkways';
import { nodeChart } from '@world/geometry';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, chartToChartInto, inChart, toOwner } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';

/**
 * TRAFFIC AND WALKERS ACROSS THE PIECES' BORDERS (`world/lanelets.ts`,
 * `world/turnPaths.ts`, `world/walkways.ts`). Run with `vitest.planet.config.ts`.
 *
 * A lane is laid on the chart of the node it leaves and a junction on its own
 * node's: across a border the lane arriving there was written on another
 * piece's chart, tens of km away in the atlas. Every turn between it and a
 * lane leaving the junction, swept on the junction's plate, fitted no body -
 * no car was born at or drove through such a node - and every corner of
 * footway joined across it ran 1 to 22 km.
 */

const ROAD = 1;

function draw(doc: RoadDoc, net: Network, chart: number, a: Vec2, b: Vec2) {
  const c = tileCentre(chart);
  const p = { x: c.x + a.x, y: c.y + a.y }, q = { x: c.x + b.x, y: c.y + b.y };
  return commitRoadPath(doc, net, { kind: 'free', at: p }, { kind: 'free', at: q }, ROAD,
    [{ start: { at: p, heightOffset: 0 }, end: { at: q, heightOffset: 0 }, curve: null }]);
}

/** A long road east across several pieces, and one across it drawn from the piece three along. */
function town(chart: number): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  doc.setBalance(1e9);
  const net = new Network(doc);
  net.rebuild();
  expect(draw(doc, net, chart, { x: -150, y: 40 }, { x: 1650, y: -30 }).committed).toBe(true);
  const c = tileCentre(chart);
  const start = toOwner(chart, { x: c.x + 1300, y: c.y - 250 });
  const other = chartAt(start.x, start.y);
  const o = tileCentre(other);
  const from = inChart(other, start);
  const to = chartToChartInto(chart, other, c.x + 1300, c.y + 450, { x: 0, y: 0 });
  expect(draw(doc, net, other, { x: from.x - o.x, y: from.y - o.y }, { x: to.x - o.x, y: to.y - o.y }).committed).toBe(true);
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

describe('traffic and walkers across the borders between pieces', () => {
  for (const [where, chart] of [
    ['in the middle of a cube face', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5],
    ['beside a corner of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1],
  ] as const) {
    it(`fits a car through every turn, at nodes across a border too, ${where}`, () => {
      const { doc, net } = town(chart);
      const graph = new LaneletGraph();
      graph.build(doc, net);
      // The case under test is there: lanes arriving from another piece's chart.
      let across = 0;
      for (const c of graph.connectors.values()) {
        const from = graph.lanelets.get(c.fromLane)!;
        if (from.from !== undefined && nodeChart(doc, from.from) !== nodeChart(doc, c.node)) across++;
        // A car (body class 1) through every movement of a plain street.
        expect(c.maxBodyClass, `${c.id}`).toBeGreaterThanOrEqual(1);
        // The turn is laid on the node's chart (a road carried straight on
        // through a node of two has one of no length: nothing to lay).
        if (c.length === 0) continue;
        const start = graph.lanelets.get(c.id)!.centre.sampleAt(0).p;
        expect(chartAt(start.x, start.y)).toBe(nodeChart(doc, c.node));
      }
      expect(across).toBeGreaterThan(0);
    });

    it(`walks round every corner on one chart, a few metres long, ${where}`, () => {
      const { net } = town(chart);
      const g = buildWalkways(net);
      for (const way of g.ways) {
        const xy = way.path.xy;
        const own = chartAt(xy[0]!, xy[1]!);
        for (let i = 2; i < xy.length; i += 2) expect(chartAt(xy[i]!, xy[i + 1]!)).toBe(own);
        // A corner of a crossroads, a zebra, a footway of a piece of road.
        const longest = way.kind === 'corner' ? 40 : way.kind === 'crossing' ? 30 : 205;
        expect(way.path.length, `${way.kind} ${way.id}`).toBeLessThan(longest);
      }
      // Every footway end joined on: no island at a node across a border.
      const used = new Map<number, number>();
      for (const way of g.ways) for (const n of [way.a, way.b]) used.set(n, (used.get(n) ?? 0) + 1);
      const ends = [...used.values()].filter((count) => count === 1).length;
      // (A road's end off the map is joined across by an unmarked crossing.)
      expect(ends).toBe(0);
    });
  }
});
