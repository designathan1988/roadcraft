import { clamp } from '@core/scalar';
import { DT, MAX_FRAME, MAX_SUBSTEPS } from './params';

/** Fixed-timestep clock with an accumulator. */
export class SimClock {
  /** Written ONLY at the end of `pipeline.step`, so a step driven directly */
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

  /** Advances by wall-clock seconds, calling `step` once per fixed interval. */
  advance(wallDelta: number, step: () => void, budgetMs = Infinity, now: () => number = () => performance.now()): number {
    this.lastSteps = 0;
    this.lastStepMs = 0;
    if (this.paused) return 1;

    // Clamped at both ends.
    this.acc += snapToTicks(clamp(wallDelta, 0, MAX_FRAME)) * this.speed;

    let n = 0;
    const start = this.acc >= DT ? now() : 0;
    let spent = 0;
    while (this.acc >= DT && n < MAX_SUBSTEPS) {
      step();
      this.acc -= DT;
      n++;
      spent = now() - start;
      // Another step only if it would end inside the budget, at the mean cost of the steps so far
      if (spent + spent / n > budgetMs) break;
    }
    this.lastSteps = n;
    this.lastStepMs = n > 0 ? spent / n : 0;

    // Shed the debt rather than carrying it: catching up over later frames only makes the stall worse.
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

/** A frame's measured time, snapped to a whole number of ticks when it is within `SNAP` of one. */
const SNAP = 0.0005;
function snapToTicks(seconds: number): number {
  for (let k = 1; k <= 4; k++) if (Math.abs(seconds - k * DT) < SNAP) return k * DT;
  return seconds;
}
