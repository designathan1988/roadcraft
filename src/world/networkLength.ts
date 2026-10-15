import type { SegmentId } from './ids';
import type { Network } from './network';

/** Lengths are summed in millionths of a unit, as integers: exact, in whatever order an edit adds and takes them. */
const SCALE = 1e6;

/**
 * The summed length of the network's roads (each ribbon's centreline), kept
 * by what each rebuild changed (`Network.changesSince`): the roads it changed
 * taken out and put back, the others as they were. Summed as integers
 * (`SCALE`), so the total after any run of edits is the total of the roads
 * as they are, never a float that drifted with them. DO NOT sum every ribbon
 * of the map at each revision: every road drawn walked the town's roads.
 */
export class NetworkLength {
  private net: Network | null = null;
  private seen: object | null = null;
  private readonly bySegment = new Map<SegmentId, number>();
  private total = 0;

  of(net: Network): number {
    if (this.net !== net) { this.net = net; this.seen = null; }
    if (this.seen === net.state) return this.total / SCALE;
    const delta = this.seen === null ? null : net.changesSince(this.seen);
    this.seen = net.state;
    if (delta === null) this.sumAll(net);
    else {
      for (const id of delta.segments) {
        this.total -= this.bySegment.get(id) ?? 0;
        this.bySegment.delete(id);
        this.put(net, id);
      }
    }
    return this.total / SCALE;
  }

  /**
   * Every road summed again.
   * @rebuild The first ask, a map opened, or a network further behind than it remembers.
   */
  private sumAll(net: Network): void {
    this.bySegment.clear();
    this.total = 0;
    for (const id of net.ribbons.keys()) this.put(net, id);
  }

  private put(net: Network, id: SegmentId): void {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) return;
    const length = Math.round(ribbon.full.length * SCALE);
    this.bySegment.set(id, length);
    this.total += length;
  }
}
