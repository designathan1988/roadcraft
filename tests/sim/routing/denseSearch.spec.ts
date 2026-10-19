import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import type { LaneletId } from '@world/lanelets';
import type { BodyClass } from '@world/conflictPoints';
import { step } from '@sim/pipeline';
import { planTrip } from '@sim/drive/tactical';
import { routeToDestination } from '@sim/routing/destination';
import { planTripOld } from '../indexes/oracle/tripSearchOld';
import { routeToDestinationOld } from '../indexes/oracle/routeSearchOld';
import { avenueGrid } from '../support/trace';

/** SIM-01: the trip searches over dense slots and typed arrays give the routes the string searches gave, plan for plan. */
describe('the dense trip searches', () => {
  it('plan every trip as the string searches did, in traffic', () => {
    const { sim } = avenueGrid();
    const rng = new Rng(0x51b01);
    const links = [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link').map((l) => l.id);
    let compared = 0, changes = 0;
    for (let round = 0; round < 8; round++) {
      for (let k = 0; k < 300; k++) step(sim, { traffic: true, pedestrians: true });
      for (let k = 0; k < 120; k++) {
        const start = links[rng.int(0, links.length - 1)]!, goal = links[rng.int(0, links.length - 1)]!;
        const body = rng.int(0, 2) as BodyClass;
        const startS = rng.float() * (sim.lanelet(start)!.length);
        const startChange = rng.float() < 0.8, fallback = rng.float() < 0.7;
        const shape = rng.float() < 0.15 ? 'bus' : 'car';
        const now = planTrip(sim, start, startS, goal, body, startChange, shape, fallback);
        const was = planTripOld(sim, start, startS, goal, body, startChange, shape, fallback);
        expect(now, `${start} → ${goal}`).toEqual(was);
        if (was?.changeTo) changes++;
        expect(routeToDestination(sim, start, goal, body)).toEqual(routeToDestinationOld(sim, start, goal, body));
        compared++;
      }
    }
    expect(compared).toBe(960);
    // The plans that begin with a lane change (the search's second state per lane, and its second search) are among them.
    expect(changes).toBeGreaterThan(20);
  }, 120_000);

  it('make no Map entries a search', () => {
    const { sim } = avenueGrid();
    for (let k = 0; k < 600; k++) step(sim, { traffic: true, pedestrians: true });
    const links = [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link').map((l) => l.id);
    const pairs: [LaneletId, LaneletId][] = [];
    for (let i = 0; i < links.length; i += 7) pairs.push([links[i]!, links[(i * 13 + 5) % links.length]!]);
    const search = (): void => {
      for (const [a, b] of pairs) {
        planTrip(sim, a, 0, b, 1);
        routeToDestination(sim, a, b, 1);
      }
    };
    // Warm: the lanes' slots and the reach components, made once.
    search();
    let sets = 0;
    const original = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      sets++;
      return original.call(this, key, value);
    };
    try {
      search();
    } finally {
      Map.prototype.set = original;
    }
    // Before: two to three entries for every state the searches relaxed, thousands here.
    expect(sets).toBe(0);
  }, 60_000);
});
