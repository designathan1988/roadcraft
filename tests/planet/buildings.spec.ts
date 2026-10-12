import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { footprintRects } from '@world/buildings/geometry';
import { pickBuilding } from '@world/buildings/pick';
import { ROAD_CLEARANCE, touchesRoad } from '@world/buildings/validate';
import { type Building, asBuildingId } from '@world/buildings/types';
import { Level, ROAD_TYPES, halfWidth } from '@world/roadTypes';
import { footprintSize, snapPlacement } from '@editor/buildingSnap';
import { commitRoadPath } from '@editor/commit';

/**
 * BUILDINGS BY A ROAD ACROSS THE PIECES' BORDERS (`editor/buildingSnap.ts`,
 * `world/buildings/pick.ts`). Run with `vitest.planet.config.ts`.
 *
 * A building put by the part of a road lying over the next piece did not face
 * it (the road's ribbon read against the pointer as it stood, kept on another
 * chart), and a building could not be picked - nor bulldozed by a click - from
 * its part across a border.
 */

// Over an edge of the cube: west of the second piece of face 3.
const chart = 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1;
const c = tileCentre(chart);
// Moved out as the border moved (`_border.ts`); the scenes in 0.4 m units, times U.
const shift = borderShift(chart, -1, 0);
const at = (x: number, y: number): Vec2 => toOwner(chart, { x: c.x - (x * U + shift), y: c.y + y * U });

describe('buildings by a road across the borders', () => {
  it('face the road from the part of it over the next piece, flush with its footway', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const a = at(0, 0), b = onChartOf(at(600, 0), a);
    const type = 1;
    expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, type,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    const body = blueprintByKey('house')!.body;
    const size = footprintSize(body);
    const back = halfWidth(ROAD_TYPES[type]!, Level.Sidewalk) + ROAD_CLEARANCE;
    const charts = new Set<number>();
    for (const x of [100, 205, 215, 230, 240, 260, 330, 450]) {
      const cursor = at(x, 30);
      charts.add(chartAt(cursor.x, cursor.y));
      const snap = snapPlacement(doc, net, size, cursor, 0.7);
      expect(snap.kind, `at ${x}`).toBe('road');
      const building = { ...instantiate(body, snap.anchor, snap.rotation), id: asBuildingId(1) } as Building;
      const rects = footprintRects(building);
      expect(rects.every((rect) => !touchesRoad(net, rect)), `at ${x}`).toBe(true);
      // Its front on the back of the footway: the nearest corner that far from the road's line.
      // Distance from the road's straight line, on the point's own chart.
      const line = (p: Vec2): number => {
        const u = onChartOf(at(x - 50, 0), p), w = onChartOf(at(x + 50, 0), p);
        const dx = w.x - u.x, dy = w.y - u.y;
        return Math.abs((p.x - u.x) * dy - (p.y - u.y) * dx) / Math.hypot(dx, dy);
      };
      const nearest = Math.min(...rects.flat().map(line));
      expect(nearest, `at ${x}`).toBeGreaterThan(back - 0.5 * U);
      expect(nearest, `at ${x}`).toBeLessThan(back + 0.5 * U);
    }
    expect(charts.size).toBeGreaterThan(1);
  });

  it('is picked from its part across a border', () => {
    const body = blueprintByKey('house')!.body;
    // A house kept on its chart, standing over the border into the next piece.
    // The border west of the piece's centre, and the house's anchor just east of it.
    let border = 0;
    for (let x = 150 * U + shift; x < 300 * U + shift; x += 0.5 * U) {
      const p = toOwner(chart, { x: c.x - x, y: c.y });
      if (chartAt(p.x, p.y) !== chart) { border = x; break; }
    }
    expect(border).toBeGreaterThan(0);
    const anchor = toOwner(chart, { x: c.x - (border - 2 * U), y: c.y });
    const b = { ...instantiate(body, anchor, 0), id: asBuildingId(1) } as Building;
    const ring = footprintRects(b)[0]!;
    const middle = ring.reduce((s, p) => ({ x: s.x + p.x / ring.length, y: s.y + p.y / ring.length }), { x: 0, y: 0 });
    // Its corner furthest west - over the border - a little in from it, kept on the piece it lies on.
    const west = ring.reduce((best, p) => (p.x < best.x ? p : best));
    const there = toOwner(chartAt(b.x, b.y), { x: west.x + (middle.x - west.x) * 0.1, y: west.y + (middle.y - west.y) * 0.1 });
    // Straight down onto it, as the view's ray reads it there (`ToolView.ray`).
    const ray = { ox: there.x, oy: there.y, oz: 500 * U, dx: 0, dy: 0, dz: -1 };
    const hit = pickBuilding([b], ray, () => 0);
    expect(chartAt(there.x, there.y) !== chartAt(b.x, b.y) ? hit : 'same chart', 'the point is on the next piece').not.toBe('same chart');
    expect(hit).not.toBeNull();
    expect(hit!.face).toBe('top');
  });
});
