import { Digest } from '@core/digest';
import type { Lanelet, LaneletId } from '@world/lanelets';
import { m } from '@world/units';

/** Cell of the lanes' grid, world units. */
const LANE_CELL = m(30);

const cellKey = (gx: number, gy: number): number => (gx + 32768) * 65536 + (gy + 32768);

/**
 * The lanes of the graph by place (a fixed grid of their bounds), each lane's
 * digest (`digest`), worked out when a lot first asks for it, and each lane's
 * place in the graph's order (`rank`), made when first asked. Made once per
 * lane graph (`parking.ts` laneGrid): every bay and every lot used to measure
 * every lane of the town.
 */
export class LaneGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly digests: Float64Array;
  private rankOf: Map<LaneletId, number> | null = null;

  constructor(readonly key: string, readonly lanes: readonly Lanelet[]) {
    this.digests = new Float64Array(lanes.length).fill(NaN);
    lanes.forEach((lane, i) => {
      const box = lane.centre.bbox;
      for (let gx = Math.floor(box.minX / LANE_CELL); gx <= Math.floor(box.maxX / LANE_CELL); gx++) {
        for (let gy = Math.floor(box.minY / LANE_CELL); gy <= Math.floor(box.maxY / LANE_CELL); gy++) {
          const k = cellKey(gx, gy);
          const list = this.cells.get(k);
          if (list) list.push(i); else this.cells.set(k, [i]);
        }
      }
    });
  }

  /** The places in `lanes` of the lanes filed in the cells a box covers, in the graph's order. */
  private indicesIn(x0: number, y0: number, x1: number, y1: number): number[] {
    const picked = new Set<number>();
    for (let gx = Math.floor(x0 / LANE_CELL); gx <= Math.floor(x1 / LANE_CELL); gx++) {
      for (let gy = Math.floor(y0 / LANE_CELL); gy <= Math.floor(y1 / LANE_CELL); gy++) {
        for (const i of this.cells.get(cellKey(gx, gy)) ?? []) picked.add(i);
      }
    }
    return [...picked].sort((a, b) => a - b);
  }

  /** `near`, as the lanes' places in `lanes` (all of them for a point that is not one). */
  indicesNear(x: number, y: number, reach: number): number[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.lanes.map((_, i) => i);
    return this.indicesIn(x - reach, y - reach, x + reach, y + reach);
  }

  /**
   * The lanes whose bounds come within `reach` of a point (their cells), in
   * the graph's order (the tie-break); every lane for a point that is not one.
   */
  near(x: number, y: number, reach: number): readonly Lanelet[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.lanes;
    return this.indicesNear(x, y, reach).map((i) => this.lanes[i]!);
  }

  /**
   * The lanes whose bounds meet a box, in the graph's order: what a loop over
   * every lane with the same bounds test keeps, in the order it keeps them.
   */
  inBox(x0: number, y0: number, x1: number, y1: number): Lanelet[] {
    const out: Lanelet[] = [];
    for (const i of this.indicesIn(x0, y0, x1, y1)) {
      const lane = this.lanes[i]!, box = lane.centre.bbox;
      if (box.maxX < x0 || box.minX > x1 || box.maxY < y0 || box.minY > y1) continue;
      out.push(lane);
    }
    return out;
  }

  /**
   * A lane's part of a lot's key (`parking.ts` lotBaysOf): its id, its length
   * and its centre line, digested once per lane of the grid. A lane is never
   * changed in place (`Lanelet` is read-only, its `Polyline` immutable) and
   * the grid is made again with the lanes: a rebuilt lane is digested again,
   * to the same number when it is the same lane, so a lot whose lanes were
   * only rebuilt keeps its bays.
   */
  digest(i: number): number {
    let value = this.digests[i]!;
    if (Number.isNaN(value)) {
      const lane = this.lanes[i]!;
      value = new Digest().addText(lane.id).add(lane.length).addAll(lane.centre.xy).value();
      this.digests[i] = value;
    }
    return value;
  }

  /** Each lane's place in the graph's order (`inBox`'s order), to sort what was found by it. */
  rank(): (id: LaneletId) => number {
    const rank = this.rankOf ??= new Map(this.lanes.map((lane, i) => [lane.id, i]));
    return (id) => rank.get(id) ?? Infinity;
  }
}
