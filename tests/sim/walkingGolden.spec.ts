import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { avenueGrid, traceRun } from './support/trace';

/** The walkers among the traffic as they were before SIM-28 and SIM-36: crossing gaps, waits and steps, bit for bit, with a fixed seed. */
describe('walking golden', () => {
  it('walks and drives exactly as before', () => {
    const { sim } = avenueGrid(0x77);
    sim.usePedestrianEngine(createAgentWalkEngine());
    const rng = new Rng(0x3a);
    const ways = [...sim.walkwaysNow().walkways()].filter((w) => w.path.length > 20);
    let trips = 0;
    for (let k = 0; k < 120; k++) {
      const a = ways[rng.int(0, ways.length - 1)]!, b = ways[rng.int(0, ways.length - 1)]!;
      const p = a.path.sampleAt(a.path.length * rng.float()).p, q = b.path.sampleAt(b.path.length * rng.float()).p;
      if (sim.pedEngine.walkTrip!(sim, { trip: k, fromX: p.x, fromY: p.y, toX: q.x, toY: q.y, seed: k + 1, ageClass: 'adult' }) !== null) trips++;
    }
    expect(trips).toBeGreaterThan(60);
    const trace = traceRun(sim, 3600);
    expect(trace).toEqual({ hash: 74238317, vehicles: 108, laneChanges: 77, routeChanges: 152 });
  }, 120_000);
});
