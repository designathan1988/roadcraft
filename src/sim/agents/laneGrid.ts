import { Digest } from '@core/digest';
import { ChangeLog } from '@core/changeLog';
import type { GraphChange, Lanelet, LaneletGraph, LaneletId } from '@world/lanelets';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/** Cell of the lanes' grid, world units. */
const LANE_CELL = m(30);

const cellKey = (gx: number, gy: number): number => (gx + 32768) * 65536 + (gy + 32768);
const byId = (a: Lanelet, b: Lanelet): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Filed {
  readonly lane: Lanelet;
  readonly cells: readonly number[];
  /** The lane's digest (`digest`), worked out when first asked; NaN until then. */
  digest: number;
}

/**
 * The lanes of the graph by place (a fixed grid of their bounds) and each
 * lane's digest (`digest`), kept by what each build of the lane graph changed
 * (`SimWorld.topologyLog`): the lanes an edit made or took filed in or out,
 * the others as they were. What it finds comes in lane id order, whatever
 * order the edits filed them in. The boxes of the lanes that changed, before
 * and after, are logged (`changes`) for what was worked out from the lanes
 * near it (`parking.ts`: a lot's bays). DO NOT file every lane of the map
 * again when the graph moves: every road drawn filed the town's lanes, and
 * every lot of the town was worked out again.
 */
export class LaneGrid {
  private readonly filed = new Map<LaneletId, Filed>();
  private readonly cells = new Map<number, LaneletId[]>();
  private seen: object | null = null;
  /** The boxes of the lanes each follow changed, before and after (null: every lane). */
  readonly changes = new ChangeLog<readonly ChangeRect[]>();

  /** Brought up to the lane graph's changes since it was last. */
  follow(graph: LaneletGraph, log: ChangeLog<GraphChange>): void {
    const since = log.since(this.seen);
    if (since !== null && !since.length) return;
    this.seen = log.state;
    if (since === null) {
      // @rebuild A world's first topology, or a lane graph built whole.
      this.filed.clear();
      this.cells.clear();
      for (const lane of graph.lanelets.values()) this.file(lane);
      this.changes.push(null);
      return;
    }
    const boxes: ChangeRect[] = [];
    for (const change of since) {
      for (const id of change.lanelets) {
        const was = this.filed.get(id);
        const now = graph.lanelets.get(id);
        if (was && was.lane === now) continue;
        if (was) { this.unfile(was); boxes.push(boxOf(was.lane)); }
        if (now) { this.file(now); boxes.push(boxOf(now)); }
      }
    }
    if (boxes.length) this.changes.push(boxes);
  }

  private file(lane: Lanelet): void {
    const box = lane.centre.bbox;
    const cells: number[] = [];
    for (let gx = Math.floor(box.minX / LANE_CELL); gx <= Math.floor(box.maxX / LANE_CELL); gx++) {
      for (let gy = Math.floor(box.minY / LANE_CELL); gy <= Math.floor(box.maxY / LANE_CELL); gy++) {
        const k = cellKey(gx, gy);
        cells.push(k);
        const list = this.cells.get(k);
        if (list) list.push(lane.id); else this.cells.set(k, [lane.id]);
      }
    }
    this.filed.set(lane.id, { lane, cells, digest: NaN });
  }

  private unfile(was: Filed): void {
    for (const k of was.cells) {
      const list = this.cells.get(k);
      if (!list) continue;
      const i = list.indexOf(was.lane.id);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.cells.delete(k);
    }
    this.filed.delete(was.lane.id);
  }

  /** The lanes filed in the cells a box covers, in id order. */
  private lanesIn(x0: number, y0: number, x1: number, y1: number): Lanelet[] {
    const picked = new Set<LaneletId>();
    for (let gx = Math.floor(x0 / LANE_CELL); gx <= Math.floor(x1 / LANE_CELL); gx++) {
      for (let gy = Math.floor(y0 / LANE_CELL); gy <= Math.floor(y1 / LANE_CELL); gy++) {
        for (const id of this.cells.get(cellKey(gx, gy)) ?? []) picked.add(id);
      }
    }
    return [...picked].map((id) => this.filed.get(id)!.lane).sort(byId);
  }

  /**
   * The lanes whose bounds come within `reach` of a point (their cells), in
   * id order (the tie-break); every lane for a point that is not one.
   */
  near(x: number, y: number, reach: number): readonly Lanelet[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [...this.filed.values()].map((f) => f.lane).sort(byId);
    return this.lanesIn(x - reach, y - reach, x + reach, y + reach);
  }

  /**
   * The lanes whose bounds meet a box, in id order: what a loop over every
   * lane with the same bounds test keeps.
   */
  inBox(x0: number, y0: number, x1: number, y1: number): Lanelet[] {
    const out: Lanelet[] = [];
    for (const lane of this.lanesIn(x0, y0, x1, y1)) {
      const box = lane.centre.bbox;
      if (box.maxX < x0 || box.minX > x1 || box.maxY < y0 || box.minY > y1) continue;
      out.push(lane);
    }
    return out;
  }

  /**
   * A lane's part of a lot's key (`parking.ts` lotBaysOf): its id, its length
   * and its centre line, digested once per lane filed. A lane is never
   * changed in place (`Lanelet` is read-only, its `Polyline` immutable): a
   * rebuilt lane is filed again and digested again, to the same number when
   * it is the same lane, so a lot whose lanes were only rebuilt keeps its bays.
   */
  digest(lane: Lanelet): number {
    const filed = this.filed.get(lane.id);
    if (!filed || filed.lane !== lane) return digestOf(lane);
    if (Number.isNaN(filed.digest)) filed.digest = digestOf(lane);
    return filed.digest;
  }
}

const digestOf = (lane: Lanelet): number => new Digest().addText(lane.id).add(lane.length).addAll(lane.centre.xy).value();

function boxOf(lane: Lanelet): ChangeRect {
  const b = lane.centre.bbox;
  return [b.minX, b.minY, b.maxX, b.maxY];
}

/** The world's lanes' grid (`SimWorld.laneGrid`), brought up to the lane graph's changes. */
export function laneGrid(w: SimWorld): LaneGrid {
  w.laneGrid.follow(w.graph, w.topologyLog);
  return w.laneGrid;
}

/** The lanes whose bounds come within `reach` of a point, in id order (`LaneGrid.near`). */
export function lanesNear(w: SimWorld, x: number, y: number, reach: number): readonly Lanelet[] {
  return laneGrid(w).near(x, y, reach);
}

/** The lanes whose bounds meet a box, in id order (`LaneGrid.inBox`). */
export function lanesInBox(w: SimWorld, x0: number, y0: number, x1: number, y1: number): Lanelet[] {
  return laneGrid(w).inBox(x0, y0, x1, y1);
}

/**
 * The boxes of the lanes the lane graph changed since `seen` (`LaneGrid.changes`,
 * before and after; null: every lane), and the state now: for what was worked out
 * from the lanes near a place (a bus stop's lane, a train's level crossings).
 */
export function laneChangesSince(w: SimWorld, seen: object | null): { readonly state: object; readonly boxes: readonly ChangeRect[] | null } {
  const grid = laneGrid(w);
  const since = grid.changes.since(seen);
  return { state: grid.changes.state, boxes: since === null ? null : since.flat() };
}
