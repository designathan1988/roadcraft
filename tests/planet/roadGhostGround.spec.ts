import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, FLAT_GROUND } from '@world/elevation';
import { tileCentre, tileCellOf } from '@world/planet/atlas';
import { chartAt, inChart, toOwner } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { borderAlong } from './_border';

/**
 * THE ROAD'S HEIGHT FIELD ACROSS A BORDER (`world/elevation.ts`
 * `ghostProfiles`). Run with `vitest.planet.config.ts`.
 *
 * A road written on one piece's chart that runs over the border onto the next
 * piece was not in the height field as that next piece asks it - in its own
 * coordinates. The ground there was never cut under it, and on the screen a
 * strip of grass crossed the asphalt at the border (seen 2026-10-11); the
 * people and cars standing on the paving read the bare ground there too.
 */

const ROAD = 1;
const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;

function lay(doc: RoadDoc, net: Network, a: Vec2, b: Vec2): void {
  const c = tileCentre(chart);
  const p = { x: c.x + a.x, y: c.y + a.y }, q = { x: c.x + b.x, y: c.y + b.y };
  commitRoadPath(doc, net, { kind: 'free', at: p }, { kind: 'free', at: q }, ROAD,
    [{ start: { at: p, heightOffset: 0 }, end: { at: q, heightOffset: 0 }, curve: null }]);
  net.rebuild();
}

describe('a road across a piece\'s border, as the next piece asks it', () => {
  it('is found, and shapes the ground, on both sides of the border', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const border = borderAlong(chart, 1, 0);
    // A road 120 units long whose middle sits 20 units past the border, on this chart's map.
    lay(doc, net, { x: border - 40, y: 10 }, { x: border + 80, y: 10 });
    const elevation = buildRoadElevation(net, FLAT_GROUND);
    const c = tileCentre(chart);
    let misses = 0, checked = 0;
    for (let d = -30; d <= 30; d += 2) {
      // The same ground, asked where it is kept: on the piece it lies on.
      const here = toOwner(chart, { x: c.x + border + d, y: c.y + 10 });
      if (tileCellOf(here.x, here.y) === chart && d > 0) continue;
      checked++;
      const road = elevation.roadAt(here.x, here.y);
      if (road.type < 0 || Math.abs(road.across) > 1) misses++;
      // Under the carriageway the ground is cut below the deck.
      const shape = elevation.shapeAt(here.x, here.y, elevation.at(here.x, here.y) + 5);
      if (!(shape.weight > 0.99 && shape.height < elevation.at(here.x, here.y))) misses++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(misses).toBe(0);
  });

  it('the next piece\'s ground is in the boxes a change of the road marks (`differences`)', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const before = buildRoadElevation(net, FLAT_GROUND);
    const border = borderAlong(chart, 1, 0);
    lay(doc, net, { x: border - 40, y: 10 }, { x: border + 80, y: 10 });
    const after = buildRoadElevation(net, FLAT_GROUND, before);
    const boxes = after.differences?.(before) ?? [];
    const c = tileCentre(chart);
    const there = toOwner(chart, { x: c.x + border + 10, y: c.y + 10 });
    expect(chartAt(there.x, there.y)).not.toBe(chart);
    expect(boxes.some((b) => there.x >= b.minX && there.x <= b.maxX && there.y >= b.minY && there.y <= b.maxY)).toBe(true);
    // And the near end, on this chart's own map.
    const near = inChart(chart, toOwner(chart, { x: c.x + border - 10, y: c.y + 10 }));
    expect(boxes.some((b) => near.x >= b.minX && near.x <= b.maxX && near.y >= b.minY && near.y <= b.maxY)).toBe(true);
  });
});
