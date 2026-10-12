import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { tileCentre } from '@world/planet/atlas';
import { onChartOf, toOwner } from '@world/planet/charts';
import { applyLots, lotCentre, planLots } from '@world/lots';
import { commitRoadPath } from '@editor/commit';

/**
 * THE LOTS ALONG A LONG STREET ON THE PLANET (`world/lots.ts`). Run with
 * `vitest.planet.config.ts`.
 *
 * A street on the planet is laid in pieces of at most 80 m (`PLANET_MAX_PIECE`),
 * a node between each two; the strip of lots along it broke at every one of
 * them, a lot's width of grass left in the row (seen in the game).
 */
const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);
const at = (x: number, y: number): Vec2 => toOwner(chart, { x: c.x + x, y: c.y + y });

describe('the lots along a long street on the planet', () => {
  it('run on unbroken over the nodes between its pieces and the borders', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const a = at(-420, 0), b = onChartOf(at(420, 0), a);
    const r = commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]);
    expect(r.committed).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    expect(doc.segments.size).toBeGreaterThan(3);
    applyLots(doc, planLots(doc, net));
    // Each side's lots along the street, on the first piece's chart.
    for (const side of [1, -1]) {
      const spans = doc.lots
        .map((l) => l.corners.map((p) => onChartOf(p, a)))
        .filter((cs) => Math.sign(lotCentre({ corners: cs }).y - a.y) === side)
        .map((cs) => [Math.min(...cs.map((p) => p.x)), Math.max(...cs.map((p) => p.x))] as const)
        .sort((p, q) => p[0] - q[0]);
      expect(spans.length).toBeGreaterThan(10);
      let gap = 0;
      for (let i = 1; i < spans.length; i++) gap = Math.max(gap, spans[i]![0] - spans[i - 1]![1]);
      expect(gap, JSON.stringify(spans.map((s) => s.map((v) => Math.round(v - a.x))))).toBeLessThan(m(1.5));
    }
  });
});
