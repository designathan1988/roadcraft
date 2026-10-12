import { workUntil } from '@core/frameWork';
import { rebindPeds, rebindVehicles } from '@sim/pipeline';
import type { SimWorld } from '@sim/world';

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

/** Milliseconds a frame spends bringing the traffic's topology up to date. */
const TOPOLOGY_SLICE_MS = 6;
/**
 * The same while the town is being opened, its frames not yet shown: a load
 * has its own time each frame (Unity's background loading priority), not what
 * an edit may take - and since none of these frames is seen, a long one costs
 * nothing a short one would not, while every extra frame pays its own drawing
 * again. Built in one go before the first frame, the conflict zones alone
 * held the opening 423 ms; at 25 ms a frame, on a GPU drawing the loading
 * town in 350 ms frames, the traffic stood still for 7 s after it appeared.
 */
const LOADING_SLICE_MS = 250;

/**
 * The traffic's topology brought up to an edit's road plan, a few
 * milliseconds a frame, the simulation held meanwhile: first the conflict
 * zones of the new junctions measured on a graph of their own and the
 * vehicles swapped onto it, then the footways, then the walkers rebound in
 * the frame after - each drawn in between. Together in one frame they were
 * a stall of up to 240 ms after every edit (docs/performance.md #11).
 */
export class TopologyCatchUp {
  private vehicles: { revision: number; steps: Generator<void, void> } | null = null;
  private walks: { revision: number; steps: Generator<void, void, void> } | null = null;
  private pedsToRebind = false;

  /**
   * One frame's share of the work towards `revision` (the network's
   * `trafficRevision`). True when the simulation must stay still this frame;
   * `worldBusy`: the road itself is still being built, and goes first;
   * `loading`: the town is being opened (`LOADING_SLICE_MS`).
   */
  step(sim: SimWorld, revision: number, worldBusy: boolean, loading = false): boolean {
    const slice = (): number => (loading ? performance.now() + LOADING_SLICE_MS : workUntil(TOPOLOGY_SLICE_MS) || performance.now() + 1);
    if (sim.topologyRevision === revision) {
      if (this.pedsToRebind) {
        this.pedsToRebind = false;
        rebindPeds(sim);
        return false;
      }
      return false;
    }
    // The road of an edit being built first: the frame's allowance goes to
    // it. A load has its own time, and works alongside.
    if (worldBusy && !loading) return true;
    if (sim.vehicleTopologyRevision !== revision) {
      if (!this.vehicles || this.vehicles.revision !== revision) {
        this.vehicles = { revision, steps: sim.prepareVehicleTopology() };
      }
      const until = slice();
      let prep = this.vehicles.steps.next();
      while (!prep.done && performance.now() < until) prep = this.vehicles.steps.next();
      if (prep.done) {
        this.vehicles = null;
        sim.rebuildVehicleTopology();
        rebindVehicles(sim);
      }
      return true;
    }
    if (!this.walks || this.walks.revision !== revision) {
      this.walks = { revision, steps: sim.walkTopologySteps() };
    }
    const until = slice();
    let step = this.walks.steps.next();
    while (!step.done && performance.now() < until) step = this.walks.steps.next();
    if (step.done) {
      this.walks = null;
      this.pedsToRebind = true;
    }
    return true;
  }
}
