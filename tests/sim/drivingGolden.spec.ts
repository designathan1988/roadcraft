import { describe, expect, it } from 'vitest';
import { avenueGrid, traceRun } from './support/trace';

/**
 * The driving as it was before the work on the simulation's cost (SIM-01, 02, 12, 26, 28, 36): routes, lane changes and
 * positions after every step, bit for bit, with a fixed seed. A change that makes the simulation cheaper keeps these.
 */
describe('driving golden', () => {
  it('routes, changes lanes and moves exactly as before', () => {
    const { sim } = avenueGrid();
    const trace = traceRun(sim, 6000);
    expect(trace.laneChanges).toBeGreaterThan(20);
    expect(trace).toEqual({ hash: 3121588635, vehicles: 202, laneChanges: 166, routeChanges: 455 });
  });
});
