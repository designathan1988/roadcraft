import { describe, expect, it } from 'vitest';

import { BLUEPRINTS, instantiate } from '../../src/world/buildings/blueprints';
import { cameraSolids } from '../../src/world/buildings/cameraSolids';
import { buildingHeight, footprintCentre } from '../../src/world/buildings/geometry';
import type { Building } from '../../src/world/buildings/types';
import { m } from '../../src/world/units';

const block = (): Building => {
  const body = BLUEPRINTS.find((b) => b.key === 'block')!.body;
  return { ...instantiate(body, { x: 100, y: 50 }, 0.4), id: 1 } as Building;
};

// The camera is lifted out of a building smoothly and never kept inside it
// (`render/isoViewport.ts` `setSolids`).
describe('camera solids', () => {
  const b = block();
  const solids = cameraSolids([b], () => 10);
  const c = footprintCentre(b);

  it('keeps the eye over the roof inside the footprint', () => {
    expect(solids.floorAt(c.x, c.y)).toBeGreaterThan(10 + buildingHeight(b) - 1e-6);
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
});
