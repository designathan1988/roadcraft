import { Digest } from '@core/digest';
import { ChangeLog } from '@core/changeLog';
import type { GraphChange, Lanelet, LaneletGraph, LaneletId } from '@world/lanelets';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/** Cell of the lanes' grid, world units. */
const LANE_CELL = m(30);

const cellKey = (gx: number, gy: number): number => (gx + 32768) * 65536 + (gy + 32768);

/** Whether the grid finds a lane of these bounds for a box (`LaneGrid.near`, `lanesIn`) */
export function cellsMeet(box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number },
  x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.floor(box.minX / LANE_CELL) <= Math.floor(x1 / LANE_CELL) && Math.floor(box.maxX / LANE_CELL) >= Math.floor(x0 / LANE_CELL)
    && Math.floor(box.minY / LANE_CELL) <= Math.floor(y1 / LANE_CELL) && Math.floor(box.maxY / LANE_CELL) >= Math.floor(y0 / LANE_CELL);
}
const byId = (a: Lanelet, b: Lanelet): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Filed {
  readonly lane: Lanelet;
  readonly cells: readonly number[];
  /** The lane's digest (`digest`), worked out when first asked; NaN until then. */
  digest: number;
  /** The query that last met it (`LaneGrid.visit`): a lane in several of a query's cells is taken once. */
  visit: number;
}

/** DO NOT file every lane of the map again when the graph moves */
export class LaneGrid {
  private readonly filed = new Map<LaneletId, Filed>();
  private readonly cells = new Map<number, LaneletId[]>();
  private seen: object | null = null;
  /** The boxes of the lanes each follow changed, before and after (null: every lane). */
  readonly changes = new ChangeLog<readonly ChangeRect[]>();
  /** Lanes filed or taken out since made: the engine's ledger (`main.ts`). */
  work = 0;
  /** The query under way (`Filed.visit`). */
  private visit = 0;

  /** Brought up to the lane graph's changes since it was last. */
  follow(graph: LaneletGraph, log: ChangeLog<GraphChange>): void {
    const since = log.since(this.seen);
    if (since !== null && !since.length) return;
    this.seen = log.state;
    if (since === null) { this.fileAll(graph); return; }
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

  /** @rebuild Every lane filed again. */
  private fileAll(graph: LaneletGraph): void {
    this.filed.clear();
    this.cells.clear();
    for (const lane of graph.lanelets.values()) this.file(lane);
    this.changes.push(null);
  }

  private file(lane: Lanelet): void {
    this.work++;
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
    this.filed.set(lane.id, { lane, cells, digest: NaN, visit: 0 });
  }

  private unfile(was: Filed): void {
    this.work++;
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
    const out: Lanelet[] = [];
    this.gather(x0, y0, x1, y1, out);
    return out.sort(byId);
  }

  /** The lanes filed in the cells a box covers, each once, into `out` in no set order: DO NOT make a set and a list of them for each query (SIM-28). */
  private gather(x0: number, y0: number, x1: number, y1: number, out: Lanelet[]): void {
    const visit = ++this.visit;
    for (let gx = Math.floor(x0 / LANE_CELL); gx <= Math.floor(x1 / LANE_CELL); gx++) {
      for (let gy = Math.floor(y0 / LANE_CELL); gy <= Math.floor(y1 / LANE_CELL); gy++) {
        const list = this.cells.get(cellKey(gx, gy));
        if (!list) continue;
        for (const id of list) {
          const filed = this.filed.get(id)!;
          if (filed.visit === visit) continue;
          filed.visit = visit;
          out.push(filed.lane);
        }
      }
    }
  }

  /** `near`'s lanes into `out`, in NO set order: for a reader whose answer does not depend on it (`SimWorld.vehiclesNear` sorts its vehicles itself). */
  nearInto(x: number, y: number, reach: number, out: Lanelet[]): void {
    out.length = 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { for (const f of this.filed.values()) out.push(f.lane); return; }
    this.gather(x - reach, y - reach, x + reach, y + reach, out);
  }

  /** The lanes whose bounds come within `reach` of a point (their cells), in id order (the tie-break) */
  near(x: number, y: number, reach: number): readonly Lanelet[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [...this.filed.values()].map((f) => f.lane).sort(byId);
    return this.lanesIn(x - reach, y - reach, x + reach, y + reach);
  }

  /** The lanes whose bounds meet a box, in id order: what a loop over every lane with the same bounds test keeps. */
  inBox(x0: number, y0: number, x1: number, y1: number): Lanelet[] {
    const out: Lanelet[] = [];
    for (const lane of this.lanesIn(x0, y0, x1, y1)) {
      const box = lane.centre.bbox;
      if (box.maxX < x0 || box.minX > x1 || box.maxY < y0 || box.minY > y1) continue;
      out.push(lane);
    }
    return out;
  }

  /** A lane's part of a lot's key (`parking.ts` lotBaysOf) */
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

/** DO NOT import `SimWorld`: `sim/world.ts` imports this file, and the type import closed an import cycle */
export interface LaneGridWorld {
  readonly graph: LaneletGraph;
  readonly topologyLog: ChangeLog<GraphChange>;
  readonly laneGrid: LaneGrid;
}

/** The world's lanes' grid (`SimWorld.laneGrid`), brought up to the lane graph's changes. */
export function laneGrid(w: LaneGridWorld): LaneGrid {
  w.laneGrid.follow(w.graph, w.topologyLog);
  return w.laneGrid;
}

/** The lanes whose bounds come within `reach` of a point, in id order (`LaneGrid.near`). */
export function lanesNear(w: LaneGridWorld, x: number, y: number, reach: number): readonly Lanelet[] {
  return laneGrid(w).near(x, y, reach);
}

/** `lanesNear` into `out`, in no set order (`LaneGrid.nearInto`). */
export function lanesNearInto(w: LaneGridWorld, x: number, y: number, reach: number, out: Lanelet[]): void {
  laneGrid(w).nearInto(x, y, reach, out);
}

/** The lanes whose bounds meet a box, in id order (`LaneGrid.inBox`). */
export function lanesInBox(w: LaneGridWorld, x0: number, y0: number, x1: number, y1: number): Lanelet[] {
  return laneGrid(w).inBox(x0, y0, x1, y1);
}

/** The boxes of the lanes the lane graph changed since `seen` */
export function laneChangesSince(w: LaneGridWorld, seen: object | null): { readonly state: object; readonly boxes: readonly ChangeRect[] | null } {
  const grid = laneGrid(w);
  const since = grid.changes.since(seen);
  return { state: grid.changes.state, boxes: since === null ? null : since.flat() };
}
