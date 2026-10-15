import { rebindPeds, rebindVehicles } from '@sim/pipeline';
import type { SimWorld } from '@sim/world';
import { WAITING } from '@world/conflictPoints';
import type { PairMeasurer } from '@world/conflictTable';

/**
 * THE FRAME LOOP'S BOOKKEEPING, out of `main.ts`: what the loop keeps between
 * frames that is not the game's state. The loop itself only orchestrates -
 * input, update, render, timing (Nystrom, "Game Loop"); in a browser the
 * platform's event loop is the main loop and `requestAnimationFrame` calls
 * back each frame. `main.ts` `frame` calls the systems in order; the clocks,
 * the frame request and the traffic's topology catching up live here.
 */

/**
 * One frame asked for at a time, and the wall time between frames. The loop
 * stops when nothing moves; anything that changes the picture asks for a
 * frame. Clouds drifting alone get one every `DRIFT_MS` instead of every
 * vsync, which keeps them alive without holding the GPU at full speed.
 */
export class FrameClock {
  private pending = false;
  private last = performance.now();
  private driftQueued = false;

  /**
   * `loading`: a town is being put together unseen (`SceneHandle.opening`).
   * Its frames are then not asked of `requestAnimationFrame`, which waits
   * for the page to be visible (Chrome, "Timer throttling in Chrome 88":
   * rAF "will wait for the page to be visible") and keeps to the display's
   * rate - nothing is presented, so neither is needed - but run as tasks
   * through a `MessageChannel`, which neither clamps to 4 ms as `setTimeout`
   * does nor waits for a vsync (React's scheduler posts its work the same
   * way). A load in a hidden or covered pane went on drawing nothing at
   * 0 frames a second until the curtain's time limit lifted it unfinished.
   */
  constructor(private readonly frame: (now: number) => void, private readonly loading: () => boolean = () => false) {}

  private channel: MessageChannel | null = null;

  /** A frame is wanted: one is asked of the browser unless one already is. */
  request(): void {
    if (this.pending) return;
    this.pending = true;
    if (this.loading() && typeof MessageChannel !== 'undefined') {
      if (!this.channel) {
        this.channel = new MessageChannel();
        this.channel.port1.onmessage = () => {
          this.pending = false;
          this.frame(performance.now());
        };
      }
      this.channel.port2.postMessage(null);
      return;
    }
    requestAnimationFrame((now) => {
      this.pending = false;
      this.frame(now);
    });
  }

  /** Seconds since the last frame, read once at the start of each frame. */
  tick(now: number): number {
    const wall = (now - this.last) / 1000;
    this.last = now;
    return wall;
  }

  /**
   * The time stood still (unpaused, the tab shown again): the next frame
   * counts from now, so the time away does not flood the simulation.
   */
  restart(): void {
    this.last = performance.now();
  }

  /** Only the clouds are moving: a frame in `DRIFT_MS`, unless one is already on its way. */
  drift(): void {
    if (this.driftQueued) return;
    this.driftQueued = true;
    setTimeout(() => {
      this.driftQueued = false;
      this.request();
    }, DRIFT_MS);
  }
}

/** Twenty frames a second for the clouds drifting alone. */
const DRIFT_MS = 50;

/**
 * Work done every `seconds` of wall time, not every frame (the minimap ten
 * times a second, the panels two and a half). Starts due: the first frame
 * refreshes it - starting at zero, a paused map kept the page's initial
 * readout for ever, the loop having stopped before the first refresh.
 */
export class Periodic {
  private clock: number;

  constructor(private readonly seconds: number) {
    this.clock = seconds;
  }

  /** `wall` seconds went by: true when the work is due (and the clock starts over). */
  due(wall: number): boolean {
    this.clock += wall;
    if (this.clock < this.seconds) return false;
    this.clock = 0;
    return true;
  }
}

/**
 * Work done every `seconds` of the SIMULATION's time (`SimClock.time`), read by
 * the frame loop after the simulation stepped: the city growing, the buildings
 * running down, the fires. It stands still with the pause, follows the speed
 * and is the same on every machine (Fiedler, "Fix Your Timestep!": the
 * simulation consumes time in fixed steps; Nystrom, "Game Loop"). A clock gone
 * back (a new map, the simulation reset) starts it over.
 * DO NOT drive the game's own periodic work with `setInterval`.
 */
export class SimPeriodic {
  private last: number | null = null;

  constructor(private readonly seconds: number) {}

  /** The simulation stands at `time` seconds: true when the work is due (and its clock starts over). */
  due(time: number): boolean {
    if (this.last === null || time < this.last) {
      this.last = time;
      return false;
    }
    if (time - this.last < this.seconds) return false;
    this.last = time;
    return true;
  }
}

/**
 * `fn` run once, in a task of its own, after however many calls came since it
 * last ran: one timer for a burst of events, not one a call. Whether a run is
 * already asked for lives in the task itself, not loose in the caller's module.
 */
export function coalescedTask(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; fn(); }, 0);
  };
}

/**
 * The traffic's topology brought up to an edit's road plan, the simulation
 * held meanwhile: the conflict zones of the junctions the edit built again
 * measured on a graph of their own, by the workers (`conflictPool.ts`), and
 * the vehicles swapped onto it; then the footways, kerbs and zebras, and the
 * walkers rebound.
 * Each piece redoes only what the edit changed (`LaneletGraph.update`,
 * `Walkways.update`, `SidewalkGraph.update`, `CrossingSpans.update`), so it
 * runs whole in the frame the edit's road is built; only the pairs the
 * workers measure are waited for. DO NOT go back to a few milliseconds of it
 * a frame (TOPOLOGY_SLICE_MS, LOADING_SLICE_MS): spreading the work over
 * frames hid that every edit built the town's topology, and the hold grew
 * with the town.
 */
export class TopologyCatchUp {
  /** `measurer`: the workers the new junctions' conflict pairs are measured by (`conflictPool.ts`); none, on the page. */
  constructor(private readonly measurer?: PairMeasurer) {}

  private vehicles: { revision: number; steps: Generator<void | typeof WAITING, void> } | null = null;

  /**
   * This frame's work towards `revision` (the network's `trafficRevision`).
   * True when the simulation must stay still this frame (the workers still
   * measuring); `worldBusy`: the road itself is still being built, and goes
   * first.
   */
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

