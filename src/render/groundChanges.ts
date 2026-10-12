/**
 * Where the drawn ground changed, and when: the one record everything that
 * stands on the ground reads to know whether it must be built again.
 *
 * Before it, the things on the ground (walls, the transport, gardens, the
 * forest, the buildings, the plants under them) were keyed on two global
 * counters - every world rebuild and every grading anywhere - so one street
 * drawn rebuilt all of them across the whole map, even with nothing near the
 * street, even with nothing at all (the empty trains mesh relinked its shader
 * on every road edit: docs/performance.md). Now a change is recorded with the
 * rectangle it happened in (the blocks the road solve moved, the region the
 * ground was cut and filled in, a building's bank), and a dependant is built
 * again only when its own data changed or a change since its last build
 * touches the area it stands on. A dependant with nothing to draw has no area
 * and is never built again for the ground.
 */

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type Rect = readonly [number, number, number, number];

/** How many changes are remembered; a dependant older than that is built again. */
const KEPT = 512;

/**
 * What a dependant reads: the serial of the latest change, and whether a
 * change since one reaches an area. A `GroundChanges`, or a view of the
 * document's diary (`world/changes.ts`) over its ground kinds.
 */
export interface GroundRecord {
  readonly version: number;
  touches(since: number, area: Area): boolean;
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

  /**
   * Whether a change after `since` reaches `area` (`null`: a dependant with
   * nothing on the ground). An area may be the list of its items' own
   * rectangles: then only a change that reaches one of them counts. The
   * union of a whole layer's items covered most of a town, and every street
   * or lot drawn anywhere in it built the whole layer again (Nystrom, "Dirty
   * Flag": a coarse flag reprocesses what did not change).
   */
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
}

/** What a dependant stands on: one rectangle, its items' rectangles, or nothing. */
export type Area = Rect | readonly Rect[] | null;

const isRect = (area: Rect | readonly Rect[]): area is Rect => typeof area[0] === 'number';

const overlaps = (r: Rect, a: Rect): boolean => r[0] <= a[2] && r[2] >= a[0] && r[1] <= a[3] && r[3] >= a[1];

/** Grows a rectangle to take another in (`null` is nothing yet). */
export function unionRect(a: Rect | null, b: Rect): Rect {
  return a === null ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The rectangle round points, grown by `pad`; `null` for none. */
export function rectAround(points: Iterable<{ readonly x: number; readonly y: number }>, pad: number): Rect | null {
  let r: Rect | null = null;
  for (const p of points) r = unionRect(r, [p.x - pad, p.y - pad, p.x + pad, p.y + pad]);
  return r;
}

/**
 * A thing drawn on the ground: built again only when its own key changes or
 * the ground changes under its area. `stale` says whether to build it now,
 * and takes the build as done when it says so.
 */
export class GroundDependant {
  private key: string | null = null;
  private seen = -1;

  constructor(private readonly changes: GroundRecord) {}

  stale(key: string, area: Area): boolean {
    if (key === this.key && !this.changes.touches(this.seen, area)) return false;
    this.key = key;
    this.seen = this.changes.version;
    return true;
  }
}
