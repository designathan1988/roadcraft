import { describe, expect, it } from 'vitest';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, inChart, toOwner } from '@world/planet/charts';
import { chartShaper } from '@render/planet/chartShaper';
import type { TerrainShaper } from '@render/terrain';
import { borderAlong } from './_border';
import { m } from '@world/units';

/**
 * A PLATE SHAPES ITS GROUND FOR THE NEXT PIECE'S ROADS AND SITES TOO
 * (`render/planet/chartShaper.ts`). A road or a lot written on the west
 * piece's map reaches over the border onto the east piece's ground; the east
 * plate, asking only on its own map, never cut or filled for it - a wall of
 * up to 12 m along the border. Run with `vitest.planet.config.ts`.
 */

const west = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const cw = tileCentre(west);
const border = { x: cw.x + borderAlong(west, 1, 0), y: cw.y };

/** A pad levelling the ground to 3 m in a disc, written on the west piece's map, its middle 10 m short of the border. */
const pad = { x: border.x - m(10), y: border.y + m(20), r: m(30) };
const shape: TerrainShaper = {
  shapeAt: (x, y) => (Math.hypot(x - pad.x, y - pad.y) < pad.r ? { height: m(3), weight: 1 } : { height: 0, weight: 0 }),
  shapeBounds: () => [{ minX: pad.x - pad.r, minY: pad.y - pad.r, maxX: pad.x + pad.r, maxY: pad.y + pad.r }],
};

describe('the ground shaped for the roads and sites of the next piece', () => {
  // The east piece, and a point of its ground under the pad, 8 m past the border.
  const ground = toOwner(west, { x: border.x + m(8), y: border.y + m(20) });
  const east = chartAt(ground.x, ground.y);
  const ce = tileCentre(east);

  it('levels the east plate under a pad written on the west piece', () => {
    expect(east).not.toBe(west);
    const plate = chartShaper(east, ce.x, ce.y, shape);
    // Asked on the east plate's own map (about its centre), as the plate asks.
    const at = plate.shapeAt(ground.x - ce.x, ground.y - ce.y, m(20));
    expect(at.weight).toBe(1);
    expect(at.height).toBe(m(3));
    // And the plate looks there: its boxes hold the point.
    const lx = ground.x - ce.x, ly = ground.y - ce.y;
    expect(plate.shapeBounds().some((b) => lx >= b.minX && lx <= b.maxX && ly >= b.minY && ly <= b.maxY)).toBe(true);
  });

  it('agrees with the west plate on the same ground', () => {
    const plate = chartShaper(west, cw.x, cw.y, shape);
    const there = inChart(west, ground);
    expect(plate.shapeAt(there.x - cw.x, there.y - cw.y, m(20)).weight).toBe(1);
  });

  it('missed it asked on its own map only (the defect)', () => {
    expect(shape.shapeAt(ground.x, ground.y, m(20)).weight).toBe(0);
  });
});
