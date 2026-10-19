/** DYNAMIC RESOLUTION: the share of the chosen pixel ratio drawn, so the GPU's frame fits its budget (the player's option, off by default). */

/** Frames measured per decision. */
const WINDOW = 30;
/** The frame aimed at, as a share of the budget: headroom for what the measure misses. */
const AIM = 0.85;
/** The scales drawn, whole first: a few fixed sizes, so the screen's targets are made again only when it steps, never for a size a little off the last. */
const STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
/** It falls only when the scale the frames ask for is this far under the one drawn: the picture does not breathe. */
const DEADBAND = 0.05;
/** It rises one step at a time, and only when the frames ask for this much more than that step: rising wants more room than falling. */
const RISE_MARGIN = 0.05;
/** Samples left out after a change: the GPU's timings come back a few frames late, and those are of the scale before. */
const SETTLE = 5;

export class DynamicResolution {
  /** The linear share of the chosen pixel ratio being drawn: one of the steps from 1 down to `floor`. */
  scale = 1;
  private readonly costs = new Float32Array(WINDOW);
  private readonly sorted = new Float32Array(WINDOW);
  private readonly steps: readonly number[];
  private count = 0;
  private skip = 0;

  constructor(private readonly floor = 0.5) {
    this.steps = [...STEPS.filter((s) => s > floor), floor];
  }

  /** One frame's GPU cost against the budget, ms: the new scale when it should change, null to stay. */
  sample(costMs: number, budgetMs: number): number | null {
    if (!(costMs > 0) || !(budgetMs > 0)) return null;
    if (this.skip > 0) { this.skip--; return null; }
    this.costs[this.count++] = costMs;
    if (this.count < WINDOW) return null;
    this.count = 0;
    // The 90th percentile: a few slow frames count, one does not.
    const sorted = this.sorted;
    sorted.set(this.costs);
    sorted.sort();
    const cost = sorted[Math.floor(WINDOW * 0.9)]!;
    // The cost goes with the pixels, the square of the linear scale.
    const wanted = this.scale * Math.sqrt((budgetMs * AIM) / cost);
    const at = this.steps.indexOf(this.scale);
    let next = this.scale;
    if (wanted < this.scale - DEADBAND) {
      // Down at once, to the largest step that fits.
      next = this.steps.find((s) => s <= wanted) ?? this.floor;
    } else if (at > 0 && wanted >= this.steps[at - 1]! + RISE_MARGIN) {
      next = this.steps[at - 1]!;
    }
    if (next === this.scale) return null;
    this.scale = next;
    this.skip = SETTLE;
    return next;
  }

  /** Back to the whole ratio (the option switched off, the tier changed). */
  reset(): void {
    this.scale = 1;
    this.count = 0;
    this.skip = 0;
  }
}
