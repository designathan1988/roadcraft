import type { ChangeJournal } from '@world/changes';
import { NetworkLength } from '@world/networkLength';
import type { Network, SegmentRibbon } from '@world/network';
import { m, stepsIn } from '@world/units';
import { IdSlots, grown } from '@core/idSlots';
import { RunPool } from '@core/runPool';
import type { BuildingId } from '@world/buildings/types';
import type { TrafficBuildings, TrafficFacts } from '../agents/trafficBuildings';
import type { Mix } from './demand';

/** DO NOT key any of these by `doc.buildings.revision` */

/** Work done by the indexes, for the tests: buildings filed, cells read, rings tested, whole reads */
export const ambientIndexWork = { filed: 0, cells: 0, rings: 0, full: 0, verified: 0, proposals: 0, boundBroken: 0 };

/** The buildings the diary names as changed after `serial`; null when they must all be read again */
export function buildingsChangedSince(journal: ChangeJournal, serial: number): Set<number> | null {
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

/** The rows of `spotKey`: a place's step across times this, plus its step along (under half of it either way). */
const SPOT_ROW = 2 ** 26;
/** DO NOT key a bay by text: its place as one number, in steps of 0.1 m, one to a place within 3,355 km of the origin (6,710 km across) */
export const spotKey = (x: number, y: number): number => Math.round(stepsIn(x, 0.1)) * SPOT_ROW + Math.round(stepsIn(y, 0.1));

// ------------------------------------------------------------ the walls

/** The side of a wall cell: a few buildings each, a sight line of 300 m reads some twenty. */
const WALL_CELL = m(32);
/** Walls are filed over their box grown by this */
const WALL_SLACK = m(0.01);

/**
 * The buildings' solid rings in a fixed grid, kept by the diary: a sight line asks only the cells it crosses.
 * DO NOT hold a wall an object, nor a building's rings as its traffic record's arrays: each wall is a number (its box, its query mark,
 * the next wall of its building in columns, its ring's points in one typed array: `RunPool`), each building its first wall at its
 * slot (`IdSlots`), each cell its walls' numbers in the order they were filed.
 */
export class SightWalls {
  /** DO NOT follow the diary from here (`JournalCursor`): a reader that stops reading (no view to look through) keeps every entry after it for ever. One entry a tile (`TrafficBuildingTable.apply`) keeps it within what the diary holds. */
  private serial = -1;
  /** Each building's first wall, its walls linked by `next`. */
  private readonly buildings = new IdSlots(256);
  private first = new Int32Array(16);
  /** Each wall's box (x0, y0, x1, y1), the last query that read it, the next wall of its building (-1: none); its ring's x, y in `rings`. */
  private boxes = new Float64Array(64);
  private marks = new Float64Array(16);
  private next = new Int32Array(16);
  private readonly rings = new RunPool();
  private wallCount = 0;
  private freeWalls: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private query = 0;

  constructor() {
    this.buildings.onGrow = (n) => { this.first = grown(this.first, n); };
  }

  /** Takes in what the diary says changed since the last call. */
  sync(store: TrafficBuildings, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) { this.fileAll(store); return; }
    for (const id of changed) {
      this.unfile(id);
      this.file(id, store.footprints(id as BuildingId));
    }
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: TrafficBuildings): void {
    ambientIndexWork.full++;
    this.buildings.clear();
    this.cells.clear();
    this.rings.clear();
    this.wallCount = 0;
    this.freeWalls = [];
    store.eachFootprints((id, rings) => this.file(id, rings));
  }

  /** A building's walls filed (none for a building not in the store), by its footprints alone (`TrafficBuildings.footprints`). */
  private file(id: number, rings: readonly (readonly { readonly x: number; readonly y: number }[])[]): void {
    let head = -1, tail = -1;
    for (const ring of rings) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (!(x0 <= x1 && y0 <= y1)) continue;
      const wall = this.newWall();
      const box = this.boxes, at = wall * 4;
      box[at] = x0; box[at + 1] = y0; box[at + 2] = x1; box[at + 3] = y1;
      this.marks[wall] = 0;
      this.next[wall] = -1;
      let k = this.rings.put(wall, ring.length * 2);
      const d = this.rings.data;
      for (const p of ring) { d[k++] = p.x; d[k++] = p.y; }
      if (tail < 0) head = wall; else this.next[tail] = wall;
      tail = wall;
      ambientIndexWork.filed++;
      const cx0 = Math.floor((x0 - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((x1 + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((y0 - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((y1 + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          const list = this.cells.get(key);
          if (list) list.push(wall); else this.cells.set(key, [wall]);
        }
      }
    }
    if (head < 0) return;
    // The slot taken first: taking it may grow the column (`onGrow`).
    const slot = this.buildings.take(id);
    this.first[slot] = head;
  }

  private newWall(): number {
    const wall = this.freeWalls.length ? this.freeWalls.pop()! : this.wallCount++;
    if (wall >= this.next.length) {
      const n = Math.ceil(this.next.length * 1.5);
      this.boxes = grown(this.boxes, n * 4); this.marks = grown(this.marks, n); this.next = grown(this.next, n);
    }
    return wall;
  }

  private unfile(id: number): void {
    const slot = this.buildings.get(id);
    if (slot < 0) return;
    this.buildings.delete(id);
    for (let wall = this.first[slot]!; wall >= 0; wall = this.next[wall]!) {
      const box = this.boxes, at = wall * 4;
      const cx0 = Math.floor((box[at]! - WALL_SLACK) / WALL_CELL), cx1 = Math.floor((box[at + 2]! + WALL_SLACK) / WALL_CELL);
      const cy0 = Math.floor((box[at + 1]! - WALL_SLACK) / WALL_CELL), cy1 = Math.floor((box[at + 3]! + WALL_SLACK) / WALL_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          const list = this.cells.get(key);
          if (!list) continue;
          const i = list.indexOf(wall);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this.cells.delete(key);
        }
      }
      this.rings.drop(wall);
      this.freeWalls.push(wall);
    }
  }

  /** Whether a side of some wall properly crosses the segment a-b. */
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
    const box = this.boxes, marks = this.marks;
    for (;;) {
      ambientIndexWork.cells++;
      const list = this.cells.get(cellKey(cx, cy));
      if (list) {
        for (const wall of list) {
          if (marks[wall] === mark) continue;
          marks[wall] = mark;
          const at = wall * 4;
          if (box[at + 2]! < lx || box[at]! > hx || box[at + 3]! < ly || box[at + 1]! > hy) continue;
          ambientIndexWork.rings++;
          const r = this.rings.data, start = this.rings.start(wall), n = this.rings.length(wall) / 2;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            if (crosses(ax, ay, bx, by, r[start + j * 2]!, r[start + j * 2 + 1]!, r[start + i * 2]!, r[start + i * 2 + 1]!)) return true;
          }
        }
      }
      if (cx === ex && cy === ey) return false;
      // The axis whose cell edge comes first; once a column (row) is the end's, only the other moves
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
const MIX_KINDS: readonly Kind[] = ['home', 'shop', 'work', 'civic'];

/** The side of a mix cell. */
const MIX_CELL = m(128);
/** Rounding room in the test of a whole cell inside or outside the circle: the cells near the edge are counted building by building. */
const MIX_SLACK = m(0.001);

/** How many buildings of each kind (`demand.ts` kindOf) stand where. DO NOT hold a building an object: its place, kind, cell and place in its cell's list in columns at its slot (`IdSlots`), each cell's members their slots. */
export class BuildingMix {
  /** DO NOT follow the diary from here (`JournalCursor`): a reader that stops reading (no view to look through) keeps every entry after it for ever. One entry a tile (`TrafficBuildingTable.apply`) keeps it within what the diary holds. */
  private serial = -1;
  private readonly slots = new IdSlots(256);
  private xs = new Float64Array(16);
  private ys = new Float64Array(16);
  private kinds = new Uint8Array(16);
  /** Its cell's key; NaN: its place is not a number. */
  private cellOf = new Float64Array(16);
  private memberAt = new Int32Array(16);
  private readonly cells = new Map<number, { counts: Counts; members: number[] }>();
  /** Buildings whose place is not a number: within every circle, as `hypot(NaN) > r` is false. */
  private readonly nowhere = noCounts();
  private readonly all = noCounts();

  constructor() {
    this.slots.onGrow = (n) => {
      this.xs = grown(this.xs, n); this.ys = grown(this.ys, n); this.kinds = grown(this.kinds, n);
      this.cellOf = grown(this.cellOf, n); this.memberAt = grown(this.memberAt, n);
    };
  }

  /** Takes in what the diary says changed since the last call. */
  sync(store: TrafficBuildings, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) { this.fileAll(store); return; }
    for (const id of changed) {
      this.unfile(id);
      const b = store.facts(id as never);
      if (b) this.file(b);
    }
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: TrafficBuildings): void {
    ambientIndexWork.full++;
    this.slots.clear();
    this.cells.clear();
    Object.assign(this.nowhere, noCounts());
    Object.assign(this.all, noCounts());
    store.eachFacts((b) => this.file(b));
  }

  private file(b: TrafficFacts): void {
    ambientIndexWork.filed++;
    const placed = Number.isFinite(b.x) && Number.isFinite(b.y);
    const kind = b.kind;
    const slot = this.slots.take(b.id);
    this.xs[slot] = b.x; this.ys[slot] = b.y; this.kinds[slot] = MIX_KINDS.indexOf(kind);
    this.all[kind]++; this.all.total++;
    if (!placed) { this.cellOf[slot] = Number.NaN; this.nowhere[kind]++; this.nowhere.total++; return; }
    const cell = cellKey(Math.floor(b.x / MIX_CELL), Math.floor(b.y / MIX_CELL));
    this.cellOf[slot] = cell;
    let c = this.cells.get(cell);
    if (!c) this.cells.set(cell, c = { counts: noCounts(), members: [] });
    c.counts[kind]++; c.counts.total++;
    this.memberAt[slot] = c.members.length;
    c.members.push(slot);
  }

  private unfile(id: number): void {
    const slot = this.slots.get(id);
    if (slot < 0) return;
    this.slots.delete(id);
    const kind = MIX_KINDS[this.kinds[slot]!]!, cell = this.cellOf[slot]!;
    this.all[kind]--; this.all.total--;
    if (Number.isNaN(cell)) { this.nowhere[kind]--; this.nowhere.total--; return; }
    const c = this.cells.get(cell)!;
    c.counts[kind]--; c.counts.total--;
    const last = c.members.pop()!;
    if (last !== slot) { c.members[this.memberAt[slot]!] = last; this.memberAt[last] = this.memberAt[slot]!; }
    if (!c.counts.total) this.cells.delete(cell);
  }

  /** The share of each kind among the buildings within `r * 1.2` of (x, y); r = Infinity, the whole map. */
  around(x: number, y: number, r: number): Mix {
    const reach = r * 1.2;
    // As the walk's test, `hypot(b - p) > reach` leaves a building out
    const count = reach === Infinity || Number.isNaN(reach) || Number.isNaN(x) || Number.isNaN(y) ? this.all
      : !Number.isFinite(x) || !Number.isFinite(y) ? this.inCircle(0, 0, -1)
        : this.inCircle(x, y, reach);
    const total = count.total;
    return total === 0 ? { home: 0.6, shop: 0.2, work: 0.1, civic: 0.1 }
      : { home: count.home / total, shop: count.shop / total, work: count.work / total, civic: count.civic / total };
  }

  private inCircle(x: number, y: number, reach: number): Counts {
    const out = noCounts();
    out.home += this.nowhere.home; out.shop += this.nowhere.shop; out.work += this.nowhere.work; out.civic += this.nowhere.civic;
    out.total += this.nowhere.total;
    const cx0 = Math.floor((x - reach) / MIX_CELL), cx1 = Math.floor((x + reach) / MIX_CELL);
    const cy0 = Math.floor((y - reach) / MIX_CELL), cy1 = Math.floor((y + reach) / MIX_CELL);
    const xs = this.xs, ys = this.ys, kinds = this.kinds;
    const visit = (cell: number, c: { counts: Counts; members: number[] }): void => {
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
      for (const slot of c.members) {
        if (Math.hypot(xs[slot]! - x, ys[slot]! - y) > reach) continue;
        out[MIX_KINDS[kinds[slot]!]!]++; out.total++;
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

/** Street length within `r` of (x, y), world units */
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

  /** DO NOT sum every ribbon of the map when the network moves: every road drawn walked the town's roads. */
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

/** The item a roll falls on, items laid end to end: the first `k` with `roll < runningSum[k]` */
export function atRoll(runningSum: Float64Array, roll: number): number {
  let lo = 0, hi = runningSum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (roll < runningSum[mid]!) hi = mid; else lo = mid + 1;
  }
  return lo;
}
