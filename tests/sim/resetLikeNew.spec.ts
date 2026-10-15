import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { Rng } from '@core/rng';
import type { SimWorld } from '@sim/world';
import { fixtureDoc, simOf } from './support/bodies';

const SEED = 0x5eed;

/** As the game runs (`main.ts`): the panel's numbers, the scenery's life from the road ends. */
function game(): SimWorld {
  const sim = simOf(fixtureDoc(), SEED, 1);
  sim.pedestrianCount = 60;
  sim.trafficCount = 60;
  return sim;
}

const run = (sim: SimWorld, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(sim, { traffic: true, pedestrians: true });
};

/** A map opened (`main.ts` applySnapshot 'import'): the simulation and the scenery reset. */
function reopen(sim: SimWorld): void {
  sim.reset();
  sim.ambient.reset(sim);
}

/** The next draw of every random stream the world owns (the scenery's, the lots' and the lorries' among them). */
function draws(sim: SimWorld): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, rng] of Object.entries(sim.rng)) out[name] = (rng as Rng).u32();
  return out;
}

/** What a tick writes that a reset world and a new one must share: vehicles, signals and people. */
function state(sim: SimWorld): string {
  const out: string[] = [];
  for (const v of sim.vehiclesInIdOrder()) out.push(`v${v.id}:${v.archetype.id}:${v.lanelet}:${v.s}:${v.v}:${v.route.join('>')}`);
  for (const node of sim.junctionNodesInOrder()) {
    const c = sim.controllers.get(node);
    if (c) out.push(`c${node}:${c.stageIndex}:${c.sub}:${c.elapsed}`);
  }
  for (const p of sim.pedViews) out.push(`p${p.id}:${p.x}:${p.y}:${p.heading}`);
  return out.join('|');
}

describe('a reset world', () => {
  it('forgets the junction flows and the controls the advisor chose', () => {
    const sim = game();
    run(sim, 30);
    expect(sim.flow.measured).toBeGreaterThan(0);
    expect(sim.advisor.choices.size).toBeGreaterThan(0);
    reopen(sim);
    expect(sim.flow.measured).toBe(0);
    expect(sim.advisor.choices.size).toBe(0);
  });

  it('draws the same random numbers as a new world with the same seed', () => {
    const sim = game();
    run(sim, 10);
    reopen(sim);
    expect(draws(sim)).toEqual(draws(game()));
  });

  it('runs on as a new world with the same seed, at the same hour, with ids going on', () => {
    const used = game();
    run(used, 10);
    reopen(used);
    // The clock and the ids are not rewound by a reset (`SimWorld.reset`)
    const fresh = game();
    fresh.clock.tick = used.clock.tick;
    fresh.nextVehicleId = used.nextVehicleId;
    fresh.nextPersonId = used.nextPersonId;
    for (let t = 1; t <= Math.round(15 / DT); t++) {
      step(used, { traffic: true, pedestrians: true });
      step(fresh, { traffic: true, pedestrians: true });
      if (t % 25 === 0) {
        const a = state(used).split('|'), b = state(fresh).split('|');
        const i = a.findIndex((x, j) => x !== b[j]);
        if (i >= 0 || a.length !== b.length) expect(a[i] ?? `${a.length} entries`, `tick ${t}, first difference`).toBe(b[i] ?? `${b.length} entries`);
      }
    }
    expect(used.vehicles.size).toBeGreaterThan(0);
  });
});
