import type { ChangeJournal } from '@world/changes';
import { NetworkLength } from '@world/networkLength';
import type { BuildingStore } from '@world/buildings/store';
import type { Building } from '@world/buildings/types';
import type { Network, SegmentRibbon } from '@world/network';
import { solidFootprints } from '@world/buildings/geometry';
import { m } from '@world/units';
import { kindOf, type Mix } from './demand';

/**
 * The scenery's questions about the map (`ambient.ts`), answered from indexes
 * kept by the diary (`world/changes.ts`) instead of a walk over the whole map:
 *
 * - the walls between the eye and a point (`SightWalls`): a fixed grid of
 *   the buildings' solid rings (Nystrom, "Spatial Partition",
 *   gameprogrammingpatterns.com/spatial-partition.html), the line of sight
 *   reading only the cells it passes through (Amanatides and Woo, "A Fast
 *   Voxel Traversal Algorithm for Ray Tracing", 1987).
 *
 * Each index keeps the serial of the diary it last read and takes in only
 * the buildings the diary names since (`buildingsChangedSince`). A reader the
 * diary has forgotten, or a change of the whole store (a load, a clear),
 * reads the store once again.
 *
 * DO NOT key any of these by `doc.buildings.revision`: the town's ageing
 * writes a building every few seconds, and each index keyed by it was made
 * again from every building of the map that often.
 *
 * Pure: no three, no DOM.
 */

/**
 * Work done by the indexes, for the tests: buildings filed, cells read, rings
 * tested, whole reads; lots' ways worked out, lots proposed by a draw, and
 * bounds a worked-out lot broke (always 0: a draw is exact only then).
 */
export const ambientIndexWork = { filed: 0, cells: 0, rings: 0, full: 0, verified: 0, proposals: 0, boundBroken: 0 };

/**
 * The buildings the diary names as changed after `serial`; null when they
 * must all be read again (the diary forgot that far back, or an entry names
 * none: a load, a clear, a store shared).
 */
function buildingsChangedSince(journal: ChangeJournal, serial: number): Set<number> | null {
  if (serial >= journal.version) return new Set();
  const entries = journal.since(serial, ['buildings']);
  if (!entries) return null;
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!entry.ids) return null;
    for (const id of entry.ids) ids.add(id);
  }
  return ids;
}

/** A cell's key from its column and row (both within ±32 767), as `world/cells.ts`. */
export const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

// ------------------------------------------------------------ the walls

/** A solid ring of a building, with its box; `mark` is the last query that read it. */
interface Wall {
  readonly ring: readonly { readonly x: number; readonly y: number }[];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
  mark: number;
}

/** The side of a wall cell: a few buildings each, a sight line of 300 m reads some twenty. */
const WALL_CELL = m(32);
/**
 * Walls are filed over their box grown by this: a crossing that falls on a
 * cell's edge, where the traversal's arithmetic and the box's can round
 * apart, is found from either side.
 */
const WALL_SLACK = m(0.01);

/**
 * The buildings' solid rings in a fixed grid, kept by the diary: a sight
 * line asks only the cells it crosses. Answers as the walk over every wall
 * of the map it replaces (`tests/sim/ambientIndex.spec.ts`).
 */
export class SightWalls {
  private serial = -1;
  private readonly byBuilding = new Map<number, Wall[]>();
  private readonly cells = new Map<number, Set<Wall>>();
  private query = 0;

  /** Takes in what the diary says changed since the last call. */
  sync(store: BuildingStore, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) { this.fileAll(store); return; }
    for (const id of changed) {
      this.unfile(id);
      const b = store.get(id as never);
      if (b) this.file(b);
    }
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: BuildingStore): void {
    ambientIndexWork.full++;
    this.byBuilding.clear();
    this.cells.clear();
    for (const b of store.all()) this.file(b);
  }

  private file(b: Building): void {
    const walls: Wall[] = [];
    for (const ring of solidFootprints(b)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (!(x0 <= x1 && y0 <= y1)) continue;
      const wall: Wall = { ring, x0, y0, x1, y1, mark: 0 };
      walls.push(wall);
      ambientIndexWork.filed++;
      const cx0 = Math.floor((x0 - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((x1 + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((y0 - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((y1 + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = cellKey(cx, cy);
          let set = this.cells.get(k);
          if (!set) this.cells.set(k, set = new Set());
          set.add(wall);
        }
      }
    }
    if (walls.length) this.byBuilding.set(b.id, walls);
  }

  private unfile(id: number): void {
    const walls = this.byBuilding.get(id);
    if (!walls) return;
    this.byBuilding.delete(id);
    for (const wall of walls) {
      const cx0 = Math.floor((wall.x0 - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((wall.x1 + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((wall.y0 - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((wall.y1 + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = cellKey(cx, cy);
          const set = this.cells.get(k);
          if (!set) continue;
          set.delete(wall);
          if (!set.size) this.cells.delete(k);
        }
      }
    }
  }

  /**
   * Whether a side of some wall properly crosses the segment a-b. The cells
   * are visited in the order the segment passes through them (Amanatides and
   * Woo): a crossing point lies on the segment and inside the wall's box, so
   * in a cell both reach.
   */
  blocked(ax: number, ay: number, bx: number, by: number): boolean {
    const mark = ++this.query;
    const lx = Math.min(ax, bx), ly = Math.min(ay, by), hx = Math.max(ax, bx), hy = Math.max(ay, by);
    let cx = Math.floor(ax / WALL_CELL), cy = Math.floor(ay / WALL_CELL);
    const ex = Math.floor(bx / WALL_CELL), ey = Math.floor(by / WALL_CELL);
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const deltaX = stepX ? WALL_CELL / Math.abs(dx) : Infinity, deltaY = stepY ? WALL_CELL / Math.abs(dy) : Infinity;
    let maxX = stepX > 0 ? ((cx + 1) * WALL_CELL - ax) / dx : stepX < 0 ? (cx * WALL_CELL - ax) / dx : Infinity;
    let maxY = stepY > 0 ? ((cy + 1) * WALL_CELL - ay) / dy : stepY < 0 ? (cy * WALL_CELL - ay) / dy : Infinity;
    for (;;) {
      ambientIndexWork.cells++;
      const set = this.cells.get(cellKey(cx, cy));
      if (set) {
        for (const wl of set) {
          if (wl.mark === mark) continue;
          wl.mark = mark;
          if (wl.x1 < lx || wl.x0 > hx || wl.y1 < ly || wl.y0 > hy) continue;
          ambientIndexWork.rings++;
          const r = wl.ring;
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            if (crosses(ax, ay, bx, by, r[j]!.x, r[j]!.y, r[i]!.x, r[i]!.y)) return true;
          }
        }
      }
      if (cx === ex && cy === ey) return false;
      // The axis whose cell edge comes first; once a column (row) is the
      // end's, only the other moves - rounding never carries it past the end.
      if (cy === ey || (cx !== ex && maxX < maxY)) { maxX += deltaX; cx += stepX; } else { maxY += deltaY; cy += stepY; }
    }
  }
}

/** Whether segment a-b crosses segment c-d (proper crossing). */
export function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

// ------------------------------------------------------------ the mix of the buildings

export type Kind = keyof Mix;
interface Counts { home: number; shop: number; work: number; civic: number; total: number }
const noCounts = (): Counts => ({ home: 0, shop: 0, work: 0, civic: 0, total: 0 });
interface Filed { readonly x: number; readonly y: number; readonly kind: Kind; readonly cell: number | null }

/** The side of a mix cell. */
const MIX_CELL = m(128);
/** Rounding room in the test of a whole cell inside or outside the circle: the cells near the edge are counted building by building. */
const MIX_SLACK = m(0.001);

/**
 * How many buildings of each kind (`demand.ts` kindOf) stand where: counts
 * per cell of a fixed grid and for the whole map, kept by the diary. A
 * circle reads the whole cells inside it by their counts and the buildings
 * of the cells its edge crosses one by one, by the same test as the walk
 * over every building it replaces (`AmbientWorld.mixAround`).
 */
export class BuildingMix {
  private serial = -1;
  private readonly byBuilding = new Map<number, Filed>();
  private readonly cells = new Map<number, { counts: Counts; members: Set<Filed> }>();
  /** Buildings whose place is not a number: within every circle, as `hypot(NaN) > r` is false. */
  private readonly nowhere = new Set<Filed>();
  private readonly all = noCounts();

  /** Takes in what the diary says changed since the last call. */
  sync(store: BuildingStore, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) { this.fileAll(store); return; }
    for (const id of changed) {
      this.unfile(id);
      const b = store.get(id as never);
      if (b) this.file(b);
    }
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: BuildingStore): void {
    ambientIndexWork.full++;
    this.byBuilding.clear();
    this.cells.clear();
    this.nowhere.clear();
    Object.assign(this.all, noCounts());
    for (const b of store.all()) this.file(b);
  }

  private file(b: Building): void {
    ambientIndexWork.filed++;
    const placed = Number.isFinite(b.x) && Number.isFinite(b.y);
    const cell = placed ? cellKey(Math.floor(b.x / MIX_CELL), Math.floor(b.y / MIX_CELL)) : null;
    const f: Filed = { x: b.x, y: b.y, kind: kindOf(b), cell };
    this.byBuilding.set(b.id, f);
    this.all[f.kind]++; this.all.total++;
    if (cell === null) { this.nowhere.add(f); return; }
    let c = this.cells.get(cell);
    if (!c) this.cells.set(cell, c = { counts: noCounts(), members: new Set() });
    c.counts[f.kind]++; c.counts.total++;
    c.members.add(f);
  }

  private unfile(id: number): void {
    const f = this.byBuilding.get(id);
    if (!f) return;
    this.byBuilding.delete(id);
    this.all[f.kind]--; this.all.total--;
    if (f.cell === null) { this.nowhere.delete(f); return; }
    const c = this.cells.get(f.cell)!;
    c.counts[f.kind]--; c.counts.total--;
    c.members.delete(f);
    if (!c.counts.total) this.cells.delete(f.cell);
  }

  /** The share of each kind among the buildings within `r * 1.2` of (x, y); r = Infinity, the whole map. */
  around(x: number, y: number, r: number): Mix {
    const reach = r * 1.2;
    // As the walk's test, `hypot(b - p) > reach` leaves a building out:
    // nothing is beyond an endless reach or a NaN, and a point at infinity
    // is beyond every building that has a place.
    const count = reach === Infinity || Number.isNaN(reach) || Number.isNaN(x) || Number.isNaN(y) ? this.all
      : !Number.isFinite(x) || !Number.isFinite(y) ? this.inCircle(0, 0, -1)
        : this.inCircle(x, y, reach);
    const total = count.total;
    return total === 0 ? { home: 0.6, shop: 0.2, work: 0.1, civic: 0.1 }
      : { home: count.home / total, shop: count.shop / total, work: count.work / total, civic: count.civic / total };
  }

  private inCircle(x: number, y: number, reach: number): Counts {
    const out = noCounts();
    for (const f of this.nowhere) { out[f.kind]++; out.total++; }
    const cx0 = Math.floor((x - reach) / MIX_CELL), cx1 = Math.floor((x + reach) / MIX_CELL);
    const cy0 = Math.floor((y - reach) / MIX_CELL), cy1 = Math.floor((y + reach) / MIX_CELL);
    const visit = (cell: number, c: { counts: Counts; members: Set<Filed> }): void => {
      ambientIndexWork.cells++;
      const gx = Math.floor(cell / 65536) - 32768, gy = (cell % 65536) - 32768;
      const x0 = gx * MIX_CELL - x, x1 = (gx + 1) * MIX_CELL - x, y0 = gy * MIX_CELL - y, y1 = (gy + 1) * MIX_CELL - y;
      const far = Math.hypot(Math.max(-x0, x1), Math.max(-y0, y1));
      if (far + MIX_SLACK < reach) {
        out.home += c.counts.home; out.shop += c.counts.shop; out.work += c.counts.work; out.civic += c.counts.civic;
        out.total += c.counts.total;
        return;
      }
      const near = Math.hypot(Math.max(0, x0, -x1), Math.max(0, y0, -y1));
      if (near - MIX_SLACK > reach) return;
      // The edge of the circle: each building by the walk's own test.
      for (const f of c.members) {
        if (Math.hypot(f.x - x, f.y - y) > reach) continue;
        out[f.kind]++; out.total++;
      }
    };
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cells.size) {
      for (const [cell, c] of this.cells) {
        const gx = Math.floor(cell / 65536) - 32768, gy = (cell % 65536) - 32768;
        if (gx >= cx0 && gx <= cx1 && gy >= cy0 && gy <= cy1) visit(cell, c);
      }
    } else {
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gy = cy0; gy <= cy1; gy++) {
          const k = cellKey(gx, gy);
          const c = this.cells.get(k);
          if (c) visit(k, c);
        }
      }
    }
    return out;
  }
}

// ------------------------------------------------------------ the street length

/**
 * Street length within `r` of (x, y), world units: the length of every
 * straight piece of a ribbon whose middle is that near, summed in the order
 * of `Network.ribbons` - the same sum, to the last bit, as the walk over every
 * ribbon it replaces (`AmbientWorld.roadAround`). Only the ribbons filed in
 * the cells round the place are read (`Network.ribbonsMeeting`); the whole
 * map (r = Infinity) is summed once per network.
 */
export class StreetLength {
  /** The street length of the whole map (`world/networkLength.ts`). */
  private readonly whole = new NetworkLength();
  /** Each ribbon's straight pieces as the walk reads them: middle x, middle y, length. Ribbons are never changed in place. */
  private readonly pieces = new WeakMap<SegmentRibbon, Float64Array>();

  around(net: Network, x: number, y: number, r: number): number {
    if (r === Infinity) return Number.isNaN(x) || Number.isNaN(y) ? 0 : this.wholeMap(net);
    // A NaN or a point at infinity is within no finite reach (nor is anything within a negative one).
    if (!(r >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let total = 0;
    for (const ribbon of net.ribbonsMeeting([x - r, y - r, x + r, y + r])) {
      const bb = ribbon.full.bbox;
      if (bb.maxX < x - r || bb.minX > x + r || bb.maxY < y - r || bb.minY > y + r) continue;
      total = this.add(total, ribbon, x, y, r);
    }
    return total;
  }

  /**
   * The street length of the whole map: the network's, kept by what each
   * rebuild changed (`world/networkLength.ts`). DO NOT sum every ribbon of the
   * map when the network moves: every road drawn walked the town's roads.
   */
  private wholeMap(net: Network): number {
    return this.whole.of(net);
  }

  /** The pieces of `ribbon` whose middle is within `r` of (x, y), added to `total` in order. */
  private add(total: number, ribbon: SegmentRibbon, x: number, y: number, r: number): number {
    let p = this.pieces.get(ribbon);
    if (!p) {
      const pts = ribbon.full.toPoints();
      p = new Float64Array(Math.max(0, pts.length - 1) * 3);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        p[(i - 1) * 3] = (a.x + b.x) / 2;
        p[(i - 1) * 3 + 1] = (a.y + b.y) / 2;
        p[(i - 1) * 3 + 2] = Math.hypot(b.x - a.x, b.y - a.y);
      }
      this.pieces.set(ribbon, p);
    }
    for (let i = 0; i < p.length; i += 3) if (Math.hypot(p[i]! - x, p[i + 1]! - y) <= r) total += p[i + 2]!;
    return total;
  }
}

// ------------------------------------------------------------ drawing by length

/**
 * The item a roll falls on, items laid end to end: the first `k` with
 * `roll < runningSum[k]` (the last when none), by a binary search - what a
 * walk subtracting each item's length until the roll goes below zero picks.
 */
export function atRoll(runningSum: Float64Array, roll: number): number {
  let lo = 0, hi = runningSum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (roll < runningSum[mid]!) hi = mid; else lo = mid + 1;
  }
  return lo;
}
