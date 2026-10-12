import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { segmentPolyline } from '@world/geometry';
import { segmentCost } from '@world/economy';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, chartToChartInto, inChart, toOwner } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';
import { PLANET_MAX_PIECE } from '@editor/planetFrame';
import { U } from './_border';

/**
 * ROADS CROSSING ON THE PLANET (`editor/planetFrame.ts`, `editor/commit.ts`
 * `commitOnChart`). Run with `vitest.planet.config.ts` (`__PLANET__` on).
 *
 * The player could not cross roads: a road drawn across one already there was
 * refused ("too short for the lanes to part at the junction", "overlap", "no
 * money") or laid without a junction. The edit was worked out on the
 * gesture's chart with only the roads near it brought there; a road with one
 * end brought and one not was measured across the atlas, tens of km long.
 * And the long gesture was cut every 200 m before its crossings were known,
 * a cut falling metres from a road it then crossed.
 */

const ROAD = 1;

/** A straight gesture on `chart`'s map, from `a` to `b` (offsets from its centre). */
function draw(doc: RoadDoc, net: Network, chart: number, a: Vec2, b: Vec2) {
  const c = tileCentre(chart);
  const p = { x: c.x + a.x, y: c.y + a.y }, q = { x: c.x + b.x, y: c.y + b.y };
  return commitRoadPath(doc, net, { kind: 'free', at: p }, { kind: 'free', at: q }, ROAD,
    [{ start: { at: p, heightOffset: 0 }, end: { at: q, heightOffset: 0 }, curve: null }]);
}

/** Every road's length on the sphere (each on its own chart). */
const lengths = (doc: RoadDoc): number[] => [...doc.segments.values()].map((s) => segmentPolyline(doc, s).length);

const degree = (doc: RoadDoc, id: number): number => doc.requireNode(id as never).incident.length;

/** Where lines `p0`-`p1` and `q0`-`q1` meet. */
function meet(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): Vec2 {
  const rx = p1.x - p0.x, ry = p1.y - p0.y, sx = q1.x - q0.x, sy = q1.y - q0.y;
  const t = ((q0.x - p0.x) * sy - (q0.y - p0.y) * sx) / (rx * sy - ry * sx);
  return { x: p0.x + rx * t, y: p0.y + ry * t };
}

/**
 * Lays a long road east across several pieces from `chart`'s, then one
 * across it started on the piece three along, as the player draws them: a
 * gesture starts on the piece the pointer went down on and is read on that
 * piece's map (`Viewport.holdChart`).
 */
function crossAt(chart: number) {
  const doc = new RoadDoc();
  doc.setBalance(1e9);
  const net = new Network(doc);
  net.rebuild();
  // 1800 units east, on `chart`'s map, from its own piece.
  const west = { x: -150 * U, y: 40 * U }, east = { x: 1650 * U, y: -30 * U };
  const first = draw(doc, net, chart, west, east);
  expect(first.committed, `first road refused: ${first.reason}`).toBe(true);
  // The second road crosses it 1450 units along, drawn on the map of the
  // piece its start lies on.
  const c = tileCentre(chart);
  const onChart = (p: Vec2): Vec2 => ({ x: c.x + p.x, y: c.y + p.y });
  const start = toOwner(chart, onChart({ x: 1300 * U, y: -250 * U }));
  const other = chartAt(start.x, start.y);
  const o = tileCentre(other);
  const there = (p: Vec2): Vec2 => chartToChartInto(chart, other, c.x + p.x, c.y + p.y, { x: 0, y: 0 });
  const from = inChart(other, start), to = there({ x: 1300 * U, y: 450 * U });
  const crossing = meet(from, to, there({ x: 1200 * U, y: (40 - (70 * 1350) / 1800) * U }), there({ x: 1400 * U, y: (40 - (70 * 1550) / 1800) * U }));
  const balance = doc.economy.balance;
  const second = draw(doc, net, other, { x: from.x - o.x, y: from.y - o.y }, { x: to.x - o.x, y: to.y - o.y });
  return { doc, second, other, crossing, length: Math.hypot(to.x - from.x, to.y - from.y), spent: balance - doc.economy.balance };
}

describe('roads crossing on the planet', () => {
  for (const [where, chart] of [
    ['in the middle of a cube face', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5],
    ['beside a corner of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1],
  ] as const) {
    it(`makes the crossing a junction, ${where}`, () => {
      const { doc, second, other, crossing } = crossAt(chart);
      expect(second.committed, `refused: ${second.reason}`).toBe(true);
      // One four-way junction, where the two roads cross.
      const junctions = [...doc.nodes.values()].filter((n) => n.incident.length >= 3);
      expect(junctions.map((n) => n.incident.length)).toEqual([4]);
      const at = inChart(other, junctions[0]!);
      expect(Math.hypot(at.x - crossing.x, at.y - crossing.y)).toBeLessThan(3 * U);
    });

    it(`lays no road longer than a piece, and no phantom, ${where}`, () => {
      const { doc } = crossAt(chart);
      const all = lengths(doc);
      expect(Math.max(...all)).toBeLessThanOrEqual(PLANET_MAX_PIECE + 1);
      // 1800 + 700 units drawn, give or take the charts' scale (< 0.5 %).
      const total = all.reduce((sum, l) => sum + l, 0);
      expect(total).toBeGreaterThan(2485 * U);
      expect(total).toBeLessThan(2515 * U);
    });

    it(`cuts the long roads clear of the junction, ${where}`, () => {
      const { doc } = crossAt(chart);
      const junction = [...doc.nodes.values()].find((n) => n.incident.length === 4)!;
      for (const node of doc.nodes.values()) {
        if (node === junction || degree(doc, node.id) !== 2) continue;
        const a = inChart(chartAt(junction.x, junction.y), node);
        expect(Math.hypot(a.x - junction.x, a.y - junction.y)).toBeGreaterThan(PLANET_MAX_PIECE / 2 - U);
      }
    });

    it(`charges the road drawn and nothing else, ${where}`, () => {
      const { doc, spent, length } = crossAt(chart);
      // The second road's length at one price (one class, at grade):
      // splitting the first road at the junction costs nothing.
      const perUnit = segmentCost(doc, [...doc.segments.values()][0]!, 1);
      expect(spent / perUnit / length).toBeGreaterThan(0.99);
      expect(spent / perUnit / length).toBeLessThan(1.01);
    });
  }
});
