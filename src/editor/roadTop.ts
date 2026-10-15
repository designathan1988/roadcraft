import type { Change, ChangeJournal, ChangeKind } from '@world/changes';
import { CELL, cellAt, cellRect } from '@world/cells';
import { Derived } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';

/**
 * THE HIGHEST ROAD OF THE MAP, kept by cell (`world/derived.ts` `Derived`):
 * each world cell (`world/cells.ts`) holds the highest height of the road nodes
 * standing in it, computed again only for the cells the diary says a road edit
 * or a new solve of the roads' heights reached (`roads`, `elevation`); the top
 * of the map is read from a count of the cells by whole height, its distinct
 * heights and not its cells. The pointer's picks march down their ray from
 * there (`main.ts` `surfaceTop`).
 * DO NOT walk `doc.nodes` on a road edit for the top: every street drawn read
 * every node of the city again (`main.ts`, keyed on `doc.revision`, before
 * 2026-10-14).
 */
const KINDS: readonly ChangeKind[] = ['roads', 'elevation'];

interface Source {
  readonly changes: ChangeJournal;
  readonly doc: RoadDoc;
  readonly net: Network;
}

export class RoadTop {
  private readonly source: Source;
  /** How many cells have their top at each whole height (`Math.ceil`). */
  private readonly byHeight = new Map<number, number>();
  private top = -Infinity;
  private readonly cells: Derived<Source, number, number>;

  /** `heightAt`: the solved road height at a point (`SceneHandle.elevationAt`). */
  constructor(doc: RoadDoc, net: Network, private readonly heightAt: (x: number, y: number) => number) {
    this.source = { get changes() { return doc.changes; }, doc, net };
    const count = (height: number, by: number): void => {
      const bucket = Math.ceil(height);
      const next = (this.byHeight.get(bucket) ?? 0) + by;
      if (next > 0) this.byHeight.set(bucket, next); else this.byHeight.delete(bucket);
    };
    this.cells = new Derived<Source, number, number>({
      name: 'roadTop',
      kinds: KINDS,
      byId: false,
      allKeys: (s) => allCells(s.doc),
      dirty: (change, out, s) => dirtyCells(change, out, s.doc),
      compute: (key, s) => this.cellTop(key, s),
      changed: (_key, before, after) => {
        if (before !== undefined) count(before, -1);
        if (after !== undefined) count(after, 1);
      },
    });
  }

  /**
   * The highest road node's height (rounded up to a whole unit); -Infinity
   * with no roads. Brought up to the diary first: only the cells it names.
   */
  height(): number {
    if (this.cells.refresh(this.source).size > 0) {
      let top = -Infinity;
      for (const bucket of this.byHeight.keys()) if (bucket > top) top = bucket;
      this.top = top;
    }
    return this.top;
  }

  /** What the last `height` computed: cells (for the tests). */
  get lastComputes(): number {
    return this.cells.work.last;
  }

  /** The highest node standing in cell `key`: the nodes of the roads that meet it, only those inside it. */
  private cellTop(key: number, s: Source): number | undefined {
    let top = -Infinity;
    for (const id of s.net.segmentCells.idsMeeting(cellRect(key))) {
      const segment = s.doc.segment(id);
      if (!segment) continue;
      for (const end of [segment.a, segment.b]) {
        const node = s.doc.node(end);
        if (node && cellAt(node.x, node.y) === key) top = Math.max(top, this.heightAt(node.x, node.y));
      }
    }
    return Number.isFinite(top) ? top : undefined;
  }
}

/** @rebuild The diary cannot say what moved (first look, a map loaded, a whole solve): every node's cell. */
function allCells(doc: RoadDoc): Set<number> {
  const out = new Set<number>();
  for (const node of doc.nodes.values()) out.add(cellAt(node.x, node.y));
  return out;
}

/** The cells a change's rectangles reach; a change of the whole map, every node's cell. */
function dirtyCells(change: Change, out: Set<number>, doc: RoadDoc): void {
  if (change.rects === null) {
    for (const key of allCells(doc)) out.add(key);
    return;
  }
  for (const [x0, y0, x1, y1] of change.rects) {
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL);
    const cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) out.add(cellAt((cx + 0.5) * CELL, (cy + 0.5) * CELL));
  }
}
