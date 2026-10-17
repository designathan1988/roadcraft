import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { TopologyCatchUp } from '@sim/topologyCatchUp';
import { applyOp } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';
import { fixtureDoc, simOf } from './support/bodies';
import { type PairMeasurer, pairTable } from '@world/conflictTable';

/** Pairs measured as the workers do: answered later, a frame or more after they are asked (`conflictPool.ts`). */
const later: PairMeasurer = {
  measure: (pairs) => new Promise((done) => setTimeout(() => done(pairs.map((p) => pairTable(p.a, p.b))), 0)),
};
const nextTurn = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** THE CLOCK RUNS WHILE THE TOPOLOGY IS CAUGHT UP (`TopologyCatchUp`, `SimWorld.topologyDeferred`): the city drives on the graph it has, edits of the roads coming in meanwhile, and takes the new one when ready */
describe('the topology caught up with the clock running', () => {
  for (const seed of [3, 29]) {
    it(`drives on through the edits of fuzz sequence ${seed}, and catches up to the network`, async () => {
      const sim = simOf(fixtureDoc(), 0x70b0 + seed, 2);
      const catchUp = new TopologyCatchUp(later);
      const state = { doc: sim.doc, net: sim.net, notes: [] };
      const ops = generate(seed, 12);
      let deferredTicks = 0;
      const frame = async (): Promise<void> => {
        const catching = catchUp.step(sim, sim.net.trafficRevision, false);
        sim.topologyDeferred = catching;
        for (let k = 0; k < 4; k++) {
          step(sim, { traffic: true, pedestrians: true });
          if (catching) deferredTicks++;
        }
        await nextTurn();
      };
      for (let f = 0; f < 30; f++) await frame();
      for (const op of ops) {
        try { if (!applyOp(state, op)) continue; } catch { continue; }
        sim.net.rebuild();
        for (let f = 0; f < 6; f++) await frame();
      }
      for (let f = 0; f < 200 && sim.topologyRevision !== sim.net.trafficRevision; f++) await frame();
      expect(sim.topologyRevision).toBe(sim.net.trafficRevision);
      // The clock ran while it was caught up (it stood still before: `simHost.ts` held the frame).
      expect(deferredTicks).toBeGreaterThan(0);
      expect(sim.vehicles.size).toBeGreaterThan(0);
    });
  }
});
