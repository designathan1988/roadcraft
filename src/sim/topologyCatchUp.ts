import { rebindPeds, rebindVehicles } from './pipeline';
import type { SimWorld } from './world';
import { WAITING } from '@world/conflictPoints';
import type { PairMeasurer } from '@world/conflictTable';

/** DO NOT go back to a few milliseconds of it a frame (TOPOLOGY_SLICE_MS, LOADING_SLICE_MS) */
export class TopologyCatchUp {
  /** `measurer`: the workers the new junctions' conflict pairs are measured by (`conflictPool.ts`); none, on the page. */
  constructor(private readonly measurer?: PairMeasurer) {}

  private vehicles: { revision: number; steps: Generator<void | typeof WAITING, void> } | null = null;
  private window: Generator<void | typeof WAITING, void> | null = null;

  /** The micro window's move (`SimWorld.moveWindowSteps`), as far as it goes this frame without holding the simulation; none while the topology catches up. */
  stepWindow(sim: SimWorld, revision: number): void {
    if (sim.topologyRevision !== revision) return;
    if (!this.window && !sim.windowMoving) return;
    this.window ??= sim.moveWindowSteps(this.measurer);
    let next = this.window.next();
    while (!next.done && next.value !== WAITING) next = this.window.next();
    if (next.done) this.window = null;
  }

  /** This frame's work towards `revision` (the network's `trafficRevision`). */
  step(sim: SimWorld, revision: number, worldBusy: boolean): boolean {
    if (sim.topologyRevision === revision) return false;
    if (worldBusy) return true;
    if (sim.vehicleTopologyRevision !== revision) {
      if (!this.vehicles || this.vehicles.revision !== revision) {
        this.vehicles = { revision, steps: sim.prepareVehicleTopology(this.measurer) };
      }
      let prep = this.vehicles.steps.next();
      // WAITING: the workers have the pairs; nothing to do here this frame.
      while (!prep.done && prep.value !== WAITING) prep = this.vehicles.steps.next();
      if (!prep.done) return true;
      this.vehicles = null;
      sim.rebuildVehicleTopology();
      rebindVehicles(sim);
    }
    sim.rebuildWalkTopology();
    rebindPeds(sim);
    return false;
  }
}

