import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { carryPoints, chartAt, toOwner } from '@world/planet/charts';
import { touchesRoad } from '@world/buildings/validate';
import { commitRoadPath } from '@editor/commit';

/**
 * A BUILDING'S SITE BESIDE A ROAD, ON THE PLANET (`world/buildings/validate.ts`
 * `touchesRoad`). Run with `vitest.planet.config.ts`.
 *
 * A road's segments are kept on the chart of the piece under their middle,
 * and run past the border; a site written on the next piece's chart was
 * never told the road was there, and a building could stand on it.
 */

const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);

function road(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  doc.setBalance(1e9);
  const net = new Network(doc);
  net.rebuild();
  const a = { x: c.x - 150, y: c.y }, b = { x: c.x + 1150, y: c.y };
  const laid = commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
    [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]);
  expect(laid.committed).toBe(true);
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

/** A 12 x 12 site centred `off` beside the road at `along`, kept whole on the chart of the piece under its middle. */
function site(along: number, off: number): Vec2[] {
  const middle = toOwner(chart, { x: c.x + along, y: c.y + off });
  const corners = [[-6, -6], [6, -6], [6, 6], [-6, 6]].map(([dx, dy]) => ({ x: c.x + along + dx!, y: c.y + off + dy! }));
  return carryPoints(chart, chartAt(middle.x, middle.y), corners);
}

describe('a building site beside a road across the pieces', () => {
  it('meets the road wherever it stands along it, whatever piece keeps the road there', () => {
    const { net } = road();
    const misses: number[] = [];
    for (let along = -100; along <= 1100; along += 25) {
      if (!touchesRoad(net, site(along, 10))) misses.push(along);
    }
    expect(misses).toEqual([]);
  });

  it('is clear of the road well away from it', () => {
    const { net } = road();
    for (let along = -100; along <= 1100; along += 50) expect(touchesRoad(net, site(along, 80))).toBe(false);
  });
});
