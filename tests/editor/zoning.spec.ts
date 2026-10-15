import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { ZONE_CELL, ZONE_DEPTH, buildZoneGrid } from '@world/zoneGrid';
import { Level, halfWidth } from '@world/roadTypes';

function street(angle = 0) {
  const doc = new RoadDoc();
  const c = Math.cos(angle) * 600, s = Math.sin(angle) * 600;
  const west = doc.addNode({ x: -c, y: -s });
  const east = doc.addNode({ x: c, y: s });
  const segment = doc.addSegment(west.id, east.id, 1)!;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, segment, groundAt: () => 0 };
}

describe('street zoning grid', () => {
  it('lays cells along both sides of a street, behind its footway, aligned with it at any angle', () => {
    for (const angle of [0, Math.PI / 4, 1]) {
      const { doc, net, segment } = street(angle);
      const grid = buildZoneGrid(doc, net);
      expect(grid.cells.length).toBeGreaterThan(0);
      const ribbon = net.ribbons.get(segment.id)!;
      const face = halfWidth(ribbon.road, Level.Sidewalk);
      for (const cell of grid.cells) {
        expect(cell.row).toBeLessThan(ZONE_DEPTH);
        // A cell's centre sits its row's distance behind the footway.
        const d = ribbon.full.distanceTo(cell.centre);
        expect(d).toBeCloseTo(face + (cell.row + 0.5) * ZONE_CELL, 3);
        // Its front edge runs along the street: both front corners at the same distance.
        expect(ribbon.full.distanceTo(cell.corners[0])).toBeCloseTo(ribbon.full.distanceTo(cell.corners[1]), 3);
      }
      expect(new Set(grid.cells.map((cell) => cell.side))).toEqual(new Set([1, -1]));
    }
  });

  it('keeps cells off a crossing street and its junction', () => {
    const { doc, net } = street();
    const north = doc.addNode({ x: 0, y: 400 }), south = doc.addNode({ x: 0, y: -400 });
    doc.addSegment(north.id, south.id, 1);
    net.rebuild();
    // No cell may sit on either carriageway or footway.
    const grid = buildZoneGrid(doc, net);
    for (const cell of grid.cells) {
      for (const ribbon of net.ribbons.values()) {
        expect(ribbon.full.distanceTo(cell.centre)).toBeGreaterThan(halfWidth(ribbon.road, Level.Sidewalk) - 0.1);
      }
    }
  });
});
