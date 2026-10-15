/** Where the drawn ground changed, and when */

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type Rect = readonly [number, number, number, number];

/** How many changes are remembered; a dependant older than that is built again. */
const KEPT = 512;

/** What a dependant reads: the serial of the latest change, and whether a change since one reaches an area. */
export interface GroundRecord {
  readonly version: number;
  touches(since: number, area: Area): boolean;
  /** Where the ground changed after `since`; null when the record cannot say (the whole map, or forgotten). */
  rectsSince?(since: number): readonly Rect[] | null;
}

export class GroundChanges implements GroundRecord {
  private serial = 0;
  /** Changes after `forgotten`, oldest first; `null` is the whole map. */
  private readonly log: { readonly serial: number; readonly rect: Rect | null }[] = [];
  private forgotten = 0;

  /** The serial of the latest change: what a dependant built now has seen. */
  get version(): number {
    return this.serial;
  }

  /** The ground changed in these rectangles (`null`: everywhere). An empty list changes nothing. */
  mark(rects: readonly Rect[] | null): void {
    if (rects !== null && rects.length === 0) return;
    this.serial++;
    if (rects === null) this.log.push({ serial: this.serial, rect: null });
    else for (const rect of rects) this.log.push({ serial: this.serial, rect });
    while (this.log.length > KEPT) this.forgotten = this.log.shift()!.serial;
  }

  /** Whether a change after `since` reaches `area` (`null`: a dependant with nothing on the ground). */
  touches(since: number, area: Area): boolean {
    if (area === null || since >= this.serial) return false;
    const list = isRect(area) ? [area] : area;
    if (list.length === 0) return false;
    if (since < this.forgotten) return true;
    let all: Rect | null = null;
    for (const r of list) all = unionRect(all, r);
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i]!;
      if (entry.serial <= since) break;
      const r = entry.rect;
      if (r === null) return true;
      if (!overlaps(r, all!)) continue;
      for (const a of list) if (overlaps(r, a)) return true;
    }
    return false;
  }

  rectsSince(since: number): readonly Rect[] | null {
    if (since < this.forgotten) return null;
    const out: Rect[] = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i]!;
      if (entry.serial <= since) break;
      if (entry.rect === null) return null;
      out.push(entry.rect);
    }
    return out;
  }
}

/** What a dependant stands on: one rectangle, its items' rectangles, or nothing. */
export type Area = Rect | readonly Rect[] | null;

const isRect = (area: Rect | readonly Rect[]): area is Rect => typeof area[0] === 'number';

const overlaps = (r: Rect, a: Rect): boolean => r[0] <= a[2] && r[2] >= a[0] && r[1] <= a[3] && r[3] >= a[1];

/** Grows a rectangle to take another in (`null` is nothing yet). */
export function unionRect(a: Rect | null, b: Rect): Rect {
  return a === null ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
