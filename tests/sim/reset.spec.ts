import { describe, expect, it } from 'vitest';

import { rebindAgents, step } from '@sim/pipeline';
import { createAgentWalkEngine } from '@sim/agents/walk';
import type { SimWorld } from '@sim/world';
import { m } from '@world/units';
import { DT } from '@sim/params';
import { fixtureDoc, simOf } from './support/bodies';

/** As the game runs (`main.ts`): the agents' walking engine, people and cars coming in at the road ends. */
function asTheGameRuns(sim: SimWorld): SimWorld {
  sim.usePedestrianEngine(createAgentWalkEngine());
  sim.pedestrianIntensity = 2;
  sim.pedestrianCount = 100;
  sim.trafficCount = 100;
  sim.ambient.enabled = true;
  sim.ambient.source = 'edges';
  return sim;
}

/**
 * Loading a different map starts a clean simulation. Lanelet and footway ids
 * coincide between maps, so the old rebind-after-load kept vehicles of the
 * previous map - with their routes and claims - on unrelated roads.
 */
describe('a simulation reset', () => {
  it('forgets every agent and everything learned about the old map, and runs on', () => {
    const sim = asTheGameRuns(simOf(fixtureDoc(), 0x5eed, 2));
    for (let i = 0; i < Math.round(40 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.vehicles.size).toBeGreaterThan(0);
    expect(sim.pedViews.length).toBeGreaterThan(0);

    sim.reset();
    expect(sim.vehicles.size).toBe(0);
    expect(sim.pedViews.length).toBe(0);
    expect(sim.crossingStates.size).toBe(0);
    expect(sim.runtime.size).toBe(0);
    expect(sim.segmentVolume.size).toBe(0);
    expect(sim.issues.length).toBe(0);
    expect(sim.completedTrips).toBe(0);

    // The next step rebuilds the topology and the city fills again.
    for (let i = 0; i < Math.round(30 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.vehicles.size).toBeGreaterThan(0);
    expect(sim.pedViews.length).toBeGreaterThan(0);
    for (const v of sim.vehicles.values()) expect(sim.lanelet(v.lanelet)).toBeDefined();
  });
});

describe('pedestrians on a demolished footway', () => {
  it('walk on from where they stood, not carried across the map nor stacked on one spot', () => {
    const sim = asTheGameRuns(simOf(fixtureDoc(), 0x5eed, 2));
    for (let i = 0; i < Math.round(60 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    // The road whose footways carry the most people.
    const count = new Map<number, number>();
    for (const p of sim.pedViews) if (p.segment !== undefined) count.set(p.segment, (count.get(p.segment) ?? 0) + 1);
    const [target, onIt] = [...count].sort((a, b) => b[1] - a[1])[0]!;
    expect(onIt).toBeGreaterThan(1);
    const before = new Map(sim.pedViews.map((p) => [p.id, { x: p.x, y: p.y }]));
    const onTarget = new Set(sim.pedViews.filter((p) => p.segment === target).map((p) => p.id));

    sim.doc.removeSegment(target as never);
    sim.doc.pruneOrphanNodes();
    sim.net.rebuild();
    sim.rebuildTopology();
    rebindAgents(sim);
    sim.pedEngine.publish(sim);

    const placed: { x: number; y: number }[] = [];
    for (const p of sim.pedViews) {
      if (!onTarget.has(p.id)) continue; // nobody within reach: removed cleanly
      const was = before.get(p.id)!;
      // Where they stood: a walker is moved by walking, never put elsewhere.
      expect(Math.hypot(p.x - was.x, p.y - was.y), `ped ${p.id}`).toBeLessThan(m(1));
      placed.push({ x: p.x, y: p.y });
    }
    // Not stacked: an old fallback put every orphan at the start of one footway.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(Math.hypot(placed[i]!.x - placed[j]!.x, placed[i]!.y - placed[j]!.y)).toBeGreaterThan(m(0.3));
      }
    }
    // And the town walks on.
    for (let i = 0; i < Math.round(10 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(sim.pedViews.length).toBeGreaterThan(0);
  });
});
