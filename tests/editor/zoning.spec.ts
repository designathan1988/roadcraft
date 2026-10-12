import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blockOf, growOne, marksByCell, paintCells } from '@editor/zoning';
import { validateBuilding } from '@world/buildings/validate';
import { ZONE_CELL, ZONE_DEPTH, buildZoneGrid } from '@world/zoneGrid';
import { ZONE_DENSITIES, ZONE_USES } from '@world/zones';
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

function growAll(ctx: ReturnType<typeof street>) {
  const grid = buildZoneGrid(ctx.doc, ctx.net);
  const refused = new Set<string>();
  const ids: number[] = [];
  for (let i = 0; i < 200; i++) {
    const id = growOne(ctx, grid, refused, 7);
    if (id === null) break;
    ids.push(id);
  }
  return ids;
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

describe('zoning and growth', () => {
  it('paints a block, then grows valid, non-overlapping buildings of every use and density, facing the street', () => {
    for (const use of ZONE_USES) for (const density of ZONE_DENSITIES) {
      const ctx = street();
      const grid = buildZoneGrid(ctx.doc, ctx.net);
      const front = grid.cells.find((cell) => cell.row === 0 && cell.side === 1)!;
      const changed = paintCells(ctx.doc, grid, blockOf(grid, front), { use, density });
      expect(changed, `${use} ${density}`).toBe(blockOf(grid, front).length);
      // Nothing is built by the stroke itself: buildings grow afterwards.
      expect(ctx.doc.buildings.size).toBe(0);
      const ids = growAll(ctx);
      expect(ids.length, `${use} ${density}`).toBeGreaterThan(1);
      // The whole block is used: no zoned cell is left without a building or its yard.
      const bare = ctx.doc.zoneMarks.filter((mark) => mark.building === undefined);
      expect(bare.length, `${use} ${density} bare cells`).toBe(0);
      for (const building of ctx.doc.buildings.all()) {
        expect(building.use, `${use} ${density}`).toBe(use);
        expect(validateBuilding(ctx, building), `${use} ${density}`).toBeNull();
      }
    }
  });

  it('dezoning a cell under a grown building demolishes it and frees its other cells', () => {
    const ctx = street();
    const grid = buildZoneGrid(ctx.doc, ctx.net);
    const front = grid.cells.find((cell) => cell.row === 0 && cell.side === -1)!;
    paintCells(ctx.doc, grid, blockOf(grid, front), { use: 'residential', density: 'low' });
    const ids = growAll(ctx);
    const target = ids[0]!;
    const marks = marksByCell(ctx.doc, grid);
    // The deepest cell: the rest of the lot keeps its street frontage.
    const under = grid.cells.filter((cell) => marks.get(cell.id)?.mark.building === target).sort((p, q) => q.row - p.row);
    expect(under.length).toBeGreaterThan(0);
    paintCells(ctx.doc, grid, [under[0]!], null);
    expect(ctx.doc.buildings.has(target as never)).toBe(false);
    expect(ctx.doc.zoneMarks.some((mark) => mark.building === target)).toBe(false);
    // The rest of its land is still zoned, and a building grows on it again:
    // no zoned cell is left bare.
    expect(growAll(ctx).length).toBeGreaterThan(0);
    const free = marksByCell(ctx.doc, grid);
    expect([...free.values()].filter((found) => found.mark.building === undefined)).toEqual([]);
  });

  it('round-trips zoned cells and their buildings, and finds every mark on its cell again', () => {
    const ctx = street();
    const grid = buildZoneGrid(ctx.doc, ctx.net);
    const front = grid.cells.find((cell) => cell.row === 0 && cell.side === 1)!;
    paintCells(ctx.doc, grid, blockOf(grid, front), { use: 'commercial', density: 'medium' });
    growAll(ctx);
    const restored = RoadDoc.fromJSON(ctx.doc.toJSON(), { repair: false });
    expect(restored.zoneMarks).toEqual(ctx.doc.zoneMarks);
    const net = new Network(restored);
    net.rebuild();
    const again = marksByCell(restored, buildZoneGrid(restored, net));
    expect(again.size).toBe(ctx.doc.zoneMarks.length);
  });
});
