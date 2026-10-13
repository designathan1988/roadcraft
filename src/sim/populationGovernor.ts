/**
 * THE POPULATION THE MACHINE SUSTAINS (CLAUDE.md: "no fixed population cap:
 * the limit is what the machine sustains"). The simulation's cost grows with
 * the people and the cars; measured on the player's machine, a generated town
 * of 1 348 buildings filled to 624 cars and 1 001 people cost 9-12 ms a step
 * (2026-10-13), most of a 60 Hz frame before anything was drawn.
 *
 * As Unity's Adaptive Performance does with its scalers (frame time against
 * a target, a level at a time, a delay after each change before the next),
 * the share of the population ceilings (`SimWorld.populationShare`) goes
 * down a step while a step of the simulation costs more than `HIGH_MS`, and
 * back up a step while it costs less than `LOW_MS`, never over the device's
 * own share (`max`: a narrow screen's) nor under `MIN_SHARE`, `HOLD_S`
 * seconds apart. Read per simulation step, not per frame, so the speed
 * chosen (2x, 4x) does not thin the town: a faster clock than the machine
 * can step is slowed by the clock's budget instead (`SimClock.advance`).
 *
 * Nobody is removed: over the ceiling the agents finish their trips and are
 * not replaced, so the town thins out of sight over a minute or two. A cut
 * shows only then: the next is made once the town is down to the ceilings
 * the last one set. Cut every few seconds while the cost was still the old
 * town's, it went to the floor in half a minute with the town still full
 * (measured 2026-10-13).
 *
 * Pure: fed the measured cost, the wall time and the population, it returns
 * the share to use.
 */
import { FLEET_CEILING, PED_CEILING } from './params';

/** A step costing more than this (ms, averaged) thins the town. */
const HIGH_MS = 6.5;
/** And less than this lets it fill again. */
const LOW_MS = 3.5;
/** Each change multiplies or divides the share by this. */
const STEP = 0.85;
/** The thinnest the town is made. */
const MIN_SHARE = 0.3;
/** Seconds after a change before the next, while its effect shows. */
const HOLD_S = 3;
/** The measure's memory: an exponential mean over about this many steps. */
const SMOOTHING = 60;

export class PopulationGovernor {
  private mean = 0;
  private samples = 0;
  private changedAt = -Infinity;
  private shareNow: number;

  /** `max`: the device's own share, the most the town is ever given. */
  constructor(private max: number) {
    this.shareNow = max;
  }

  /** The share in use. */
  get share(): number {
    return this.shareNow;
  }

  /** The averaged cost of a step, ms (0 before any). */
  get stepMs(): number {
    return this.mean;
  }

  /** The device's share changed (the screen narrowed or widened). */
  setMax(max: number): void {
    this.max = max;
    if (this.shareNow > max) this.shareNow = max;
  }

  /**
   * `steps` steps ran this frame at `msPerStep` each, at wall time `seconds`,
   * with `vehicles` and `people` in the town. Returns the share to use from now.
   */
  feed(steps: number, msPerStep: number, seconds: number, vehicles: number, people: number): number {
    if (steps <= 0 || !Number.isFinite(msPerStep)) return this.shareNow;
    for (let i = 0; i < steps; i++) {
      this.samples++;
      const k = 1 / Math.min(this.samples, SMOOTHING);
      this.mean += (msPerStep - this.mean) * k;
    }
    if (this.samples < SMOOTHING || seconds - this.changedAt < HOLD_S) return this.shareNow;
    // The last cut has shown: the town is within the ceilings it set.
    const settled = vehicles <= FLEET_CEILING * this.shareNow && people <= PED_CEILING * this.shareNow;
    let next = this.shareNow;
    if (this.mean > HIGH_MS && settled) next = Math.max(MIN_SHARE, this.shareNow * STEP);
    else if (this.mean < LOW_MS) next = Math.min(this.max, this.shareNow / STEP);
    if (next !== this.shareNow) {
      this.shareNow = next;
      this.changedAt = seconds;
    }
    return this.shareNow;
  }
}
