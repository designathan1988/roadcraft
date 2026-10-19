import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import { step } from '@sim/pipeline';
import { lanesNear } from '@sim/agents/laneGrid';
import type { SimWorld } from '@sim/world';
import type { Vehicle } from '@sim/vehicles/state';
import { avenueGrid } from './support/trace';

/** `vehiclesNear` as it was before SIM-28: the lanes near sorted, then the vehicles on them sorted. */
function vehiclesNearOld(w: SimWorld, x: number, y: number, reach: number): Vehicle[] {
  const out: Vehicle[] = [];
  for (const lane of lanesNear(w, x, y, reach + m(20))) {
    for (const id of w.rt(lane.id).order) {
      const v = w.vehicles.get(id);
      if (v) out.push(v);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** SIM-28: the vehicles near a point, without a set and a sort a query, the same ones in the same order. */
describe('the vehicles near a point', () => {
  it('are those the sorted lanes gave, and a yes or no about them sorts nothing', () => {
    const { sim } = avenueGrid();
    for (let k = 0; k < 1800; k++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.vehicles.size).toBeGreaterThan(30);
    const rng = new Rng(0x28);
    const points = Array.from({ length: 200 }, () => ({ x: (rng.float() - 0.5) * 1400, y: (rng.float() - 0.5) * 800, r: 20 + rng.float() * 120 }));

    const BaseSet = globalThis.Set;
    let sets = 0;
    globalThis.Set = class extends BaseSet<unknown> { constructor(v?: Iterable<unknown> | null) { super(v); sets++; } } as SetConstructor;
    let found = 0;
    try {
      for (const p of points) found += sim.vehiclesNear(p.x, p.y, p.r).length;
    } finally {
      globalThis.Set = BaseSet;
    }
    expect(found).toBeGreaterThan(100);
    // Before: a set of lanes for each query.
    expect(sets).toBe(0);

    const odd = (v: Vehicle): boolean => v.id % 3 === 0 && v.v > 1;
    for (const p of points) expect(sim.someVehicleNear(p.x, p.y, p.r, odd)).toBe(sim.vehiclesNear(p.x, p.y, p.r).some(odd));

    for (const p of points) expect(sim.vehiclesNear(p.x, p.y, p.r)).toEqual(vehiclesNearOld(sim, p.x, p.y, p.r));

    const sort = Array.prototype.sort;
    let sorts = 0;
    Array.prototype.sort = function <T>(this: T[], f?: (a: T, b: T) => number) { sorts++; return sort.call(this, f) as T[]; };
    try {
      for (const p of points) sim.someVehicleNear(p.x, p.y, p.r, () => false);
    } finally {
      Array.prototype.sort = sort;
    }
    expect(sorts).toBe(0);
  });
});
