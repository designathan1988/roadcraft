import type { NodeId, SegmentId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';

/**
 * THE FLOW AT EACH JUNCTION (docs/VIAS.md V5): vehicles an hour entering each
 * junction from each of its legs, as a trend - an exponential moving average
 * of the count per second, so a burst does not swing the control and a slow
 * change of the town's traffic does (the junction's control is chosen by the
 * trend, the player's decision of 2026-10-09). Counted where a vehicle enters
 * a junction's movement (`SimWorld.enterLanelet`), aged once a second. Fixed
 * memory: one counter and one rate per leg of a junction.
 */
const TAU = ROAD_TUNING.flow.trendWindow / 3;

export class FlowStats {
  private readonly counts = new Map<NodeId, Map<SegmentId, number>>();
  private readonly rates = new Map<NodeId, Map<SegmentId, number>>();
  private carry = 0;
  /** Seconds of traffic measured since the town was laid out (a trend needs `trendWindow`). */
  measured = 0;

  record(node: NodeId, from: SegmentId): void {
    let legs = this.counts.get(node);
    if (!legs) this.counts.set(node, legs = new Map());
    legs.set(from, (legs.get(from) ?? 0) + 1);
  }

  step(dt: number): void {
    this.carry += dt;
    this.measured += dt;
    while (this.carry >= 1) {
      this.carry -= 1;
      // Every leg ever seen ages, counted or not: a leg that went quiet fades.
      for (const [node, legs] of this.rates) {
        const counted = this.counts.get(node);
        for (const [seg, rate] of legs) legs.set(seg, rate + ((counted?.get(seg) ?? 0) * 3600 - rate) / TAU);
      }
      for (const [node, counted] of this.counts) {
        let legs = this.rates.get(node);
        if (!legs) this.rates.set(node, legs = new Map());
        for (const [seg, n] of counted) if (!legs.has(seg)) legs.set(seg, (n * 3600) / TAU);
      }
      this.counts.clear();
    }
  }

  /** Vehicles an hour entering `node` from `seg`, as a trend. */
  rate(node: NodeId, seg: SegmentId): number {
    return this.rates.get(node)?.get(seg) ?? 0;
  }

  /** Forgets what a removed junction measured. */
  keepOnly(nodes: ReadonlySet<NodeId>): void {
    for (const node of [...this.rates.keys()]) if (!nodes.has(node)) this.rates.delete(node);
  }
}
