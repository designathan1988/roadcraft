/** DYNAMIC RESOLUTION: the share of the chosen pixel ratio drawn, so the GPU's frame fits its budget (the player's option, off by default). */

/** Frames measured per decision. */
const WINDOW = 30;
/** The frame aimed at, as a share of the budget: headroom for what the measure misses. */
const AIM = 0.85;
/** No change smaller than this share: the picture does not breathe. */
const DEADBAND = 0.05;
/** The most the scale rises per decision (it falls at once). */
const RISE = 0.1;

export class DynamicResolution {
  /** The linear share of the chosen pixel ratio being drawn, `floor`..1. */
  scale = 1;
  private readonly costs = new Float32Array(WINDOW);
  private readonly sorted = new Float32Array(WINDOW);
  private count = 0;

  constructor(private readonly floor = 0.5) {}

  /** One frame's GPU cost against the budget, ms: the new scale when it should change, null to stay. */
  sample(costMs: number, budgetMs: number): number | null {
    if (!(costMs > 0) || !(budgetMs > 0)) return null;
    this.costs[this.count++] = costMs;
    if (this.count < WINDOW) return null;
    this.count = 0;
    // The 90th percentile: a few slow frames count, one does not.
    const sorted = this.sorted;
    sorted.set(this.costs);
    sorted.sort();
    const cost = sorted[Math.floor(WINDOW * 0.9)]!;
    // The cost goes with the pixels, the square of the linear scale.
    let next = this.scale * Math.sqrt((budgetMs * AIM) / cost);
    next = Math.min(1, Math.max(this.floor, Math.min(next, this.scale + RISE)));
    if (Math.abs(next - this.scale) < DEADBAND && next !== 1 && next !== this.floor) return null;
    if (next === this.scale) return null;
    this.scale = next;
    return next;
  }

  /** Back to the whole ratio (the option switched off, the tier changed). */
  reset(): void {
    this.scale = 1;
    this.count = 0;
  }
}
