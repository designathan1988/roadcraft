import type { Vec2 } from '@core/vec2';
import type { Barrier } from '@world/barriers';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import { LANDSCAPE_RADIUS, type LandscapeItem } from '@world/landscape';

/**
 * THE DOCUMENT'S SMALL ITEMS BY PLACE, for the tools: the landscaping (benches,
 * trees, signs...) and the walls, fences and hedges, filed in the world's cells
 * (`world/cells.ts` `CellFiling`) and kept in step with the diary
 * (`world/derived.ts` `JournalCursor`, by id). A tool asking what stands near the
 * pointer reads the cells round it (Nystrom, "Spatial Partition"), never the map.
 *
 * Only what the diary says came, went or changed is filed again; an entry
 * without ids (a map loaded, an undo of several items, a copy taken in) files
 * the kind again from the document - the one place it walks the map.
 * DO NOT hand a tool `doc.landscape.values()` / `doc.barriers.values()` to look
 * near a point: the bulldozer, the landscaping hover and the walls' Shift-click
 * walked every item of the map on every press or move.
 */
class ItemCells<T extends { readonly id: number }> {
  private cells = new CellFiling<number, T>();
  private readonly cursor: JournalCursor;

  constructor(
    kind: ChangeKind,
    private readonly items: (doc: RoadDoc) => ReadonlyMap<number, T>,
    private readonly bounds: (item: T) => ChangeRect,
  ) {
    this.cursor = new JournalCursor([kind], true);
  }

  /** The items whose bounds meet `rect`, in increasing id. */
  meeting(doc: RoadDoc, rect: ChangeRect): T[] {
    this.follow(doc);
    const items = this.items(doc);
    const out: T[] = [];
    for (const id of this.cells.idsMeeting(rect)) {
      const item = items.get(id);
      if (item) out.push(item);
    }
    return out;
  }

  /** The filing brought up to the document: the ids the diary names, or everything. */
  private follow(doc: RoadDoc): void {
    const entries = this.cursor.read(doc.changes);
    if (entries === null) {
      this.refile(doc);
      return;
    }
    const items = this.items(doc);
    for (const entry of entries) {
      for (const id of entry.ids!) {
        const item = items.get(id);
        if (item) this.cells.file(id, item, this.bounds(item));
        else this.cells.remove(id);
      }
    }
  }

  /** @rebuild The diary cannot say what moved (first look, a map loaded, a copy taken in): the kind filed again. */
  private refile(doc: RoadDoc): void {
    this.cells = new CellFiling<number, T>();
    for (const [id, item] of this.items(doc)) this.cells.file(id, item, this.bounds(item));
  }
}

/** The widest landscaping item's radius (`LANDSCAPE_RADIUS`). */
export const LANDSCAPE_RADIUS_MOST = Math.max(...Object.values(LANDSCAPE_RADIUS));

const landscapeOf = new WeakMap<RoadDoc, ItemCells<LandscapeItem>>();
const barriersOf = new WeakMap<RoadDoc, ItemCells<Barrier>>();

function landscapeCells(doc: RoadDoc): ItemCells<LandscapeItem> {
  let cells = landscapeOf.get(doc);
  if (!cells) landscapeOf.set(doc, cells = new ItemCells('landscape', (d) => d.landscape, (item) => [item.x, item.y, item.x, item.y]));
  return cells;
}

function barrierCells(doc: RoadDoc): ItemCells<Barrier> {
  let cells = barriersOf.get(doc);
  if (!cells) {
    barriersOf.set(doc, cells = new ItemCells('barriers', (d) => d.barriers, (barrier) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of barrier.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      return [x0, y0, x1, y1];
    }));
  }
  return cells;
}

/** The landscaping items standing within `reach` of `at` on either axis (a square: a superset of the disc), in increasing id. */
export function landscapeAround(doc: RoadDoc, at: Vec2, reach: number): LandscapeItem[] {
  return landscapeCells(doc).meeting(doc, [at.x - reach, at.y - reach, at.x + reach, at.y + reach]);
}

/** The landscaping items standing in `rect`, in increasing id. */
export function landscapeMeeting(doc: RoadDoc, rect: ChangeRect): LandscapeItem[] {
  return landscapeCells(doc).meeting(doc, rect);
}

/** The walls, fences and hedges whose path's box meets `rect`, in increasing id. */
export function barriersMeeting(doc: RoadDoc, rect: ChangeRect): Barrier[] {
  return barrierCells(doc).meeting(doc, rect);
}

/**
 * The wall, fence or hedge whose path passes nearest `at`, within `radius`
 * (`RoadDoc.barrierNear`'s rule, on the runs round the point only): a run
 * within `radius` has a box within `radius` of the point.
 */
export function barrierNear(doc: RoadDoc, at: Vec2, radius: number): Barrier | null {
  let best: Barrier | null = null;
  let bestD = radius;
  for (const barrier of barriersMeeting(doc, [at.x - radius, at.y - radius, at.x + radius, at.y + radius])) {
    for (let i = 1; i < barrier.points.length; i++) {
      const a = barrier.points[i - 1]!, b = barrier.points[i]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len)) : 0;
      const d = Math.hypot(a.x + dx * t - at.x, a.y + dy * t - at.y);
      if (d < bestD) { bestD = d; best = barrier; }
    }
  }
  return best;
}
