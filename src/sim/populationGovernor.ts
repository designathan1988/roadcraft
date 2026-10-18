/** THE POPULATION THE MACHINE SUSTAINS (CLAUDE.md: "no fixed population cap: the limit is what the machine sustains"). */
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

/** The most of the town a machine of `threads` threads is given to start with (the governor fills it from there when its steps are cheap): DO NOT start a four-thread machine at the full town, cut a 0.85 step every few seconds while its first steps run long (the weak machine's plan, 2026-10-18). */
export function cpuPopulationShare(threads: number): number {
  return threads <= 4 ? 0.5 : threads <= 8 ? 0.75 : 1;
}

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

  /** Where the share starts, before any step is measured (`cpuPopulationShare`); later calls change nothing. */
  start(share: number): void {
    if (this.samples > 0 || this.started) return;
    this.started = true;
    this.shareNow = Math.min(this.max, Math.max(MIN_SHARE, share));
  }
  private started = false;

  /** The device's share changed (the screen narrowed or widened). */
  setMax(max: number): void {
    this.max = max;
    if (this.shareNow > max) this.shareNow = max;
  }

  /** `steps` steps ran this frame at `msPerStep` each, at wall time `seconds`, with `vehicles` and `people` in the town. */
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
