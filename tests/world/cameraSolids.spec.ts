import { describe, expect, it } from 'vitest';

import { BLUEPRINTS, instantiate } from '../../src/world/buildings/blueprints';
import { cameraSolidsKeeper } from '../../src/world/buildings/cameraSolids';
import { BuildingStore } from '../../src/world/buildings/store';
import { buildingHeight, footprintCentre } from '../../src/world/buildings/geometry';
import type { Building } from '../../src/world/buildings/types';
import { m } from '../../src/world/units';

const town = new BuildingStore();
const block = (): Building => town.add(instantiate(BLUEPRINTS.find((b) => b.key === 'block')!.body, { x: 100, y: 50 }, 0.4));

// The camera is lifted out of a building smoothly and never kept inside it (`render/isoViewport.ts` `setSolids`).
describe('camera solids', () => {
  const b = block();
  // Filed as the renderer files them (`render/renderer.ts`): the keeper, the ground never moved.
  const keeper = cameraSolidsKeeper(() => 10, () => [0, 0, 0, 0], 0);
  keeper.follow(town, { version: 0, rectsSince: () => [] });
  const solids = keeper.solids();
  const c = footprintCentre(b);

  it('keeps the eye over the roof inside the footprint', () => {
    expect(solids.floorAt(c.x, c.y)).toBeGreaterThan(10 + buildingHeight(b) - 1e-6);
  });

  it('visits each volume once, though it is filed in every cell it touches', () => {
    const seen: number[] = [];
    solids.forEachIn(c.x - m(200), c.y - m(200), c.x + m(200), c.y + m(200), (_bx, _by, _cos, _sin, lx0, ly0) => { seen.push(lx0 * 1e3 + ly0); });
    expect(seen.length).toBe(b.volumes.filter((v) => !v.open).length);
    const both: number[] = [];
    solids.forEachInAny([[c.x - m(5), c.y - m(5), c.x, c.y], [c.x, c.y, c.x + m(5), c.y + m(5)]], () => { both.push(1); });
    expect(both.length).toBeLessThanOrEqual(seen.length);
  });

  it('asks nothing far from every building', () => {
    expect(solids.floorAt(c.x + m(300), c.y)).toBe(-Infinity);
  });

  it('is continuous: no jump between two points 1 mm apart, on a walk away from the building', () => {
    let last = solids.floorAt(c.x, c.y);
    let biggest = 0;
    for (let d = m(0.001); d < m(60); d += m(0.001)) {
      const now = solids.floorAt(c.x + d, c.y);
      if (Number.isFinite(now) && Number.isFinite(last)) biggest = Math.max(biggest, Math.abs(now - last));
      last = now;
    }
    expect(biggest).toBeLessThan(0.5);
  });

  it('gives the roof over a point inside the footprint only, with no margin round it', () => {
    const roof = solids.roofAt(c.x, c.y);
    expect(roof).toBeGreaterThan(10 + buildingHeight(b) - m(0.01));
    expect(roof).toBeLessThan(solids.floorAt(c.x, c.y));
    // Walking out: the roof stops at the wall, where the eye's floor still eases down.
    let d = 0;
    while (Number.isFinite(solids.roofAt(c.x + d, c.y))) d += m(0.05);
    expect(solids.roofAt(c.x + d + m(0.5), c.y)).toBe(-Infinity);
    expect(Number.isFinite(solids.floorAt(c.x + d + m(0.5), c.y))).toBe(true);
  });
});
