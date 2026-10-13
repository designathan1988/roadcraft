import { clamp } from '@core/scalar';
import { DT, MAX_FRAME, MAX_SUBSTEPS } from './params';

/**
 * Fixed-timestep clock with an accumulator.
 *
 * The V6 monolith advanced the simulation by `min(0.04, elapsed)` with no
 * accumulator, so a 200 ms frame advanced it only 40 ms. Because its signal
 * phase was derived from that same clock, traffic lights literally ran slower
 * when the map got busy (defect 5.2).
 *
 * Two rules follow from the design and both matter:
 *
 *   - `speed` multiplies the rate at which wall time is fed into the
 *     accumulator, never `DT`. Changing simulation speed therefore cannot
 *     change physics.
 *   - Time is `tick * DT`, an exact integer multiple. Nothing accumulates
 *     floating-point drift, and while paused the tick does not advance at all,
 *     so nothing can expire or be renewed during a pause. That was the third
 *     limb of the stale-reservation defect (2.7).
 */
export class SimClock {
  /**
   * Written ONLY at the end of `pipeline.step`, so a step driven directly (as
   * every spec does) advances time exactly as the game's `advance` does. It
   * used to move here, in `advance` and `run`, and every behaviour keyed on
   * the clock - signal starvation, admission FIFO, the stall watchdogs -
   * silently never happened in the suite.
   */
  tick = 0;
  paused = false;
  speed = 1;

  private acc = 0;
  /** The last `advance`: how many steps it ran and their mean wall time, ms (0 when none ran). */
  lastSteps = 0;
  lastStepMs = 0;

  get time(): number {
    return this.tick * DT;
  }

  /**
   * Advances by wall-clock seconds, calling `step` once per fixed interval.
   * Returns the interpolation alpha in [0, 1) for rendering.
   *
   * `budgetMs`: the most wall time the steps of one frame may take. Past it
   * no further step is run this frame (one always is) and the debt is shed,
   * as at `MAX_SUBSTEPS`: a simulation that costs more than real time slows
   * down instead of stretching every frame (Fiedler, "Fix Your Timestep!":
   * clamp the steps a frame and it "will appear to slow down under heavy
   * load"; Unity's Maximum Allowed Timestep caps the fixed work a frame).
   * At 4x speed six steps of 10 ms took 60 ms of every frame.
   */
  advance(wallDelta: number, step: () => void, budgetMs = Infinity, now: () => number = () => performance.now()): number {
    this.lastSteps = 0;
    this.lastStepMs = 0;
    if (this.paused) return 1;

    // Clamped at both ends. A long stall must not flood the accumulator, and a
    // clock that jumps BACKWARDS — a resumed tab, a rAF timestamp from a
    // different origin — must not drive the accumulator negative and silently
    // stop the simulation.
    this.acc += snapToTicks(clamp(wallDelta, 0, MAX_FRAME)) * this.speed;

    let n = 0;
    const start = this.acc >= DT ? now() : 0;
    let spent = 0;
    while (this.acc >= DT && n < MAX_SUBSTEPS) {
      step();
      this.acc -= DT;
      n++;
      spent = now() - start;
      // Another step only if it would end inside the budget, at the mean cost
      // of the steps so far: one of 7 ms under a budget of 8 started a second,
      // and the frame paid 14 (measured in the game, 2026-10-13).
      if (spent + spent / n > budgetMs) break;
    }
    this.lastSteps = n;
    this.lastStepMs = n > 0 ? spent / n : 0;

    // Shed the debt rather than carrying it: catching up over later frames only
    // makes the stall worse.
    if (this.acc >= DT) this.acc = 0;

    return this.acc / DT;
  }

  /** Runs exactly `n` steps, for tests and scenarios. */
  run(n: number, step: () => void): void {
    for (let i = 0; i < n; i++) step();
  }

  /** Seconds elapsed since a recorded tick. */
  since(tick: number): number {
    return (this.tick - tick) * DT;
  }
}

/**
 * A frame's measured time, snapped to a whole number of ticks when it is
 * within `SNAP` of one.
 *
 * The time between two frames is never exactly the screen's refresh: on a
 * 59.94 Hz screen (Windows calls it 59) or with a little jitter, the
 * accumulator took one tick on most frames and two on some - a frame of
 * double simulation cost now and then, and an uneven step. Snapped, a
 * vsynced frame runs the same whole number of ticks every time (Tyler Glaiel,
 * "How to make your game run at 60fps"; Frank Force, "Frame rate delta
 * buffering"; the accumulator itself is Glenn Fiedler's "Fix your timestep").
 * The time lost or gained is under a thousandth of the frame.
 */
const SNAP = 0.0005;
export function snapToTicks(seconds: number): number {
  for (let k = 1; k <= 4; k++) if (Math.abs(seconds - k * DT) < SNAP) return k * DT;
  return seconds;
}
