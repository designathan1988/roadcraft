import { describe, expect, it } from 'vitest';
import { SEARCHES_PER_TICK, mayRequestSearch, noteSearch, searchBudget } from '@sim/routing/searchScratch';
import { routeToDestination } from '@sim/routing/destination';
import { planTrip } from '@sim/drive/tactical';
import { spawnVehicle } from '@sim/vehicles/spawn';
import { fixtureDoc, simOf } from '../support/bodies';

/** THE TRIP SEARCHES' BOUNDS: a cap on the states one search expands (it gives up, never stalls), and a budget of searches a tick for the requests that can wait */

describe('a trip search', () => {
  it('gives up past its cap of expanded states, and finds the same route under it', () => {
    const sim = simOf(fixtureDoc(), 0x511a, 1);
    expect(spawnVehicle(sim)).toBe(true);
    const v = [...sim.vehicles.values()][0]!;
    const goal = v.destination!;
    const body = 0;
    const route = routeToDestination(sim, v.lanelet, goal, body as never);
    expect(route).not.toBeNull();
    const budget = searchBudget(sim, sim.clock.tick);
    const capped = budget.capped;
    // A cap below the route's own length: no route, counted.
    budget.cap = 1;
    expect(routeToDestination(sim, v.lanelet, goal, body as never)).toBeNull();
    expect(planTrip(sim, v.lanelet, v.s, goal, body as never)).toBeNull();
    expect(budget.capped).toBe(capped + 2);
    budget.cap = 6000;
    expect(routeToDestination(sim, v.lanelet, goal, body as never)).toEqual(route);
  });

  it('waits for the next tick past the tick\'s budget of searches that can wait', () => {
    const sim = simOf(fixtureDoc(), 0x511b, 1);
    const budget = searchBudget(sim, sim.clock.tick);
    budget.used = 0;
    for (let k = 0; k < SEARCHES_PER_TICK; k++) { expect(mayRequestSearch(sim)).toBe(true); noteSearch(sim); }
    const deferred = budget.deferred;
    expect(mayRequestSearch(sim)).toBe(false);
    expect(budget.deferred).toBe(deferred + 1);
    sim.clock.tick++;
    expect(mayRequestSearch(sim)).toBe(true);
  });
});
