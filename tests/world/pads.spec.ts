import { describe, expect, it } from 'vitest';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { Model } from '@world/buildings/cityBuildings';
import { instantiate } from '@world/buildings/blueprints';
import { PLINTH_MIN, floorHeight } from '@world/buildings/foundation';
import { footprintRects, localToWorld, solidFootprints } from '@world/buildings/geometry';
import { lotSurfaces } from '@world/buildings/lots';
import { LOT_PLATE, PAD_BATTER, POOL_SINK, POOL_TERRAIN_CLEARANCE, buildingPads, padsWork } from '@world/buildings/pads';
import { type Building, asBuildingId } from '@world/buildings/types';
import { m } from '@world/units';

/** A building on a slope stands on graded ground, and the grading is stable. */
describe('building pads', () => {
  const model = cityBuilding('supermarket')!;
  const b = { ...instantiate(model.body, { x: 0, y: 0 }, 0, model.fn), id: asBuildingId(1) } as Building;
  // A hillside falling 1 in 8 towards +x.
  const slope = (x: number, _y: number): number => -x / 8;
  const apron = m(6.4);
  const pads = buildingPads([b], slope, undefined, apron);
  const graded = (x: number, y: number): number => {
    const s = pads.shapeAt(x, y, slope(x, y));
    return slope(x, y) + (s.height - slope(x, y)) * s.weight;
  };

  it('levels the whole footprint', () => {
    const level = floorHeight(b, slope);
    for (const ring of footprintRects(b)) {
      for (const p of ring) expect(graded(p.x, p.y)).toBeLessThan(level);
      for (const p of ring) expect(level - graded(p.x, p.y)).toBeLessThan(m(0.2));
    }
  });

  it('grades the ground under the building to its designed level, the floor less the plinth', () => {
    // The floor is designed on the land
    const level = floorHeight(b, slope) - PLINTH_MIN;
    for (const ring of solidFootprints(b)) {
      const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
      const cy = ring.reduce((sum, p) => sum + p.y, 0) / ring.length;
      expect(graded(cx, cy)).toBeCloseTo(level, 6);
    }
  });

  it('banks back to the land at the batter, never steeper', () => {
    const ring = footprintRects(b)[0]!;
    const maxX = Math.max(...ring.map((p) => p.x));
    let prev = graded(maxX + apron, 0);
    // A step of 0.4 m at a time: the rise per step is the batter's, and the slope's.
    const step = m(0.4);
    for (let d = step; d < m(160); d += step) {
      const h = graded(maxX + apron + d, 0);
      expect(Math.abs(h - prev)).toBeLessThanOrEqual((1 / PAD_BATTER + 1 / 8) * step + 1e-6);
      prev = h;
    }
    expect(graded(maxX + m(800), 0)).toBeCloseTo(slope(maxX + m(800), 0), 6);
  });

  it('cuts the ground under a pool and its surrounding deck below the water', () => {
    const body = new Model('house', 'residential', 0)
      .block({ x: 1, y: 1, w: 8, d: 8, storeys: 1 })
      .lot(0, 12, 12, 3, 'paving')
      .lot(0, 15, 3, 4, 'paving')
      .lot(7, 15, 5, 4, 'paving')
      .lot(0, 19, 12, 3, 'paving')
      .lot(3, 15, 4, 4, 'water').build();
    const house = { ...instantiate(body, { x: 0, y: 0 }, 0, 'house'), id: asBuildingId(2) } as Building;
    const flat = () => 0;
    const water = lotSurfaces(house, floorHeight(house, flat)).find((lot) => lot.volume.open === 'water')!;
    const point = localToWorld(house, m(2), m(17));
    const ground = buildingPads([house], flat, undefined, m(4)).shapeAt(point.x, point.y, 0).height;
    expect(ground).toBeCloseTo(water.heightAt(point.x, point.y) - POOL_SINK - LOT_PLATE - POOL_TERRAIN_CLEARANCE, 6);
  });
});

describe('the platforms of a dense block', () => {
  const model = cityBuilding('supermarket')!;
  const all: Building[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) {
    all.push({ ...instantiate(model.body, { x: m(70) * i, y: m(70) * j }, (i + j) * 0.3, model.fn), id: asBuildingId(1 + i + 6 * j) } as Building);
  }
  const ground = (x: number, y: number): number => Math.sin(x / 41) * m(3) + Math.cos(y / 29) * m(2);
  const pads = buildingPads(all, ground, undefined, m(9.6));

  it('measures the rings near a point, not every ring of its cell in the platforms order', () => {
    padsWork.rings = 0;
    let corners = 0;
    for (let y = m(-60); y <= m(270); y += m(3.2)) for (let x = m(-60); x <= m(410); x += m(3.2)) { pads.shapeAt(x, y, ground(x, y)); corners++; }
    // Measured in the platforms' order against the nearest so far: 3.38 a corner; the nearest first: 1.45.
    expect(padsWork.rings / corners).toBeLessThan(2);
  });
});
