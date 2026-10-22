import { m } from '@world/units';
import { isMass, roofRise, volumeElevation, volumeHeight } from './geometry';
import { IdSlots, grown } from '@core/idSlots';
import { BuildingStore } from './store';
import { type Building, type BuildingId, volumeTop } from './types';

/** THE LOWEST THE CAMERA'S EYE MAY STAND OVER THE BUILDINGS, a continuous function of the map point */

/** How far over a roof the eye keeps, world units. */
const CLEARANCE = m(1);
/** How far round a volume its floor eases down to the building's foot, world units: the camera's radius */
const REACH = m(2);
/** The grid the volumes are filed in, world units a cell. */
const CELL = m(40);

/** DO NOT go back to an object per volume and a set per building: 29 MB of a city of 5 400. */
const STRIDE = 14;
const S_BX = 0, S_BY = 1, S_COS = 2, S_SIN = 3, S_X0 = 4, S_Y0 = 5, S_X1 = 6, S_Y1 = 7, S_FOOT = 8, S_TOP = 9;
/** What the volume surely hides (`forEachOccluder`): the bottom and top of its walls, world height, its plan inset by `S_INSET`; NaN when it hides nothing for sure (a building with voids, a volume of its own outline). */
const S_WALL0 = 10, S_WALL1 = 11, S_INSET = 12;
/** The slot of the next solid volume of the same building (-1: its last): a building's volumes a chain from its first (`SolidFiling.first`). */
const S_NEXT = 13;
/** How far the occluder's plan is drawn in from the volume's: the reliefs pushed into its faces, and a margin. */
const OCCLUDER_MARGIN = m(0.6);
const PAGE_BITS = 12;
const PAGE = 1 << PAGE_BITS;

class SolidPages {
  private pages: Float64Array[] = [];
  /** Each slot's last visit (`visitOnce`): a volume filed in several cells is visited once a walk. */
  private stamps: Uint32Array[] = [];
  private epoch = 0;
  private free: number[] = [];
  private next = 0;

  /** A slot for one volume, from the free list or a new one (a page added when it is the first of one). */
  take(): number {
    const slot = this.free.pop() ?? this.next++;
    while (this.pages.length <= slot >>> PAGE_BITS) {
      this.pages.push(new Float64Array(PAGE * STRIDE));
      this.stamps.push(new Uint32Array(PAGE));
    }
    return slot;
  }

  /** A new walk: no slot visited in it yet. */
  walk(): void {
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) { for (const s of this.stamps) s.fill(0); this.epoch = 1; }
  }

  /** True the first time `slot` is met in this walk. */
  visitOnce(slot: number): boolean {
    const stamps = this.stamps[slot >>> PAGE_BITS]!, k = slot & (PAGE - 1);
    if (stamps[k] === this.epoch) return false;
    stamps[k] = this.epoch;
    return true;
  }

  give(slot: number): void {
    this.free.push(slot);
  }

  /** The page holding `slot`, read at `at(slot) + S_*`. */
  page(slot: number): Float64Array {
    return this.pages[slot >>> PAGE_BITS]!;
  }

  clear(): void {
    this.pages = [];
    this.stamps = [];
    this.free = [];
    this.next = 0;
  }
}

/** Where a slot's numbers start in its page. */
const at = (slot: number): number => (slot & (PAGE - 1)) * STRIDE;

export interface CameraSolids {
  /** The lowest the eye may stand at (x, y), world height; -Infinity away from every building. */
  floorAt(x: number, y: number): number;
  /** The roof over (x, y) when the point is inside a solid volume's plan (its highest, no margin round it), world height */
  roofAt(x: number, y: number): number;
  /** Every solid volume filed in the cells over a map rectangle, once, as its building's frame */
  forEachIn(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void;
  /** Every solid volume filed in the cells over any of the rectangles, once for all of them. */
  forEachInAny(rects: readonly Rect[], visit: SolidVisit): void;
  /** Every volume over a map rectangle that surely hides what stands behind it (`render/occlusion.ts`): the box of its walls drawn in by its reliefs, never its roof. */
  forEachOccluder(x0: number, y0: number, x1: number, y1: number, visit: OccluderVisit): void;
}

/** An occluder as its building's frame: the building's centre and turn, the box in that frame, the walls' bottom and top (world height). */
export type OccluderVisit = (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, bottom: number, top: number) => void;

/** A solid volume as its building's frame: the building's centre and turn, the volume's box in that frame, its top. */
export type SolidVisit = (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void;

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type Rect = readonly [number, number, number, number];

/** Where and when the ground the buildings stand on changed (the diary's ground kinds, `render/renderer.ts`). */
export interface GroundSince {
  /** The serial of the latest change of the ground. */
  readonly version: number;
  /** Where the ground changed after `since`; null when the diary cannot say (everywhere). */
  rectsSince(since: number): readonly Rect[] | null;
}

/** The town's solids as filed for the camera */
export interface CameraSolidsKeeper {
  /** Moves whenever the filing changed: what the canyon light's picture stands for. */
  readonly key: string;
  /** Takes in the buildings and the ground; true when the filing changed since the last `follow`. */
  follow(buildings: BuildingStore, ground: GroundSince): boolean;
  /** The filing, brought up to the last `follow` on the first ask after it. */
  solids(): CameraSolids;
}

/** DO NOT file the town again for one building */
export function cameraSolidsKeeper(floorAt: (b: Building) => number, boxOf: (b: Building) => Rect, reach: number): CameraSolidsKeeper {
  const filing = new SolidFiling();
  let buildings: BuildingStore | null = null;
  const read = BuildingStore.cursor();
  let groundSeen = -1;
  /** Buildings to file again at the next ask (named by the diary, or the ground moved under them), or the whole town. */
  const pending = new Set<BuildingId>();
  let whole = true;
  let version = 0;
  return {
    get key() { return String(version); },
    follow(town, ground) {
      if (town !== buildings) { buildings = town; whole = true; }
      const was = pending.size;
      const wholeWas = whole;
      // Another store is another diary: the cursor reads it as everything changed.
      const ids = town.changedFor(read);
      if (ids) for (const id of ids) pending.add(id);
      else whole = true;
      if (groundSeen !== ground.version) {
        const rects = groundSeen < 0 ? null : ground.rectsSince(groundSeen);
        if (rects === null) whole = true;
        else if (!whole) {
          // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
          for (const b of town.nearAny(rects, reach, (b, r) => overlaps(boxOf(b), r))) pending.add(b.id);
        }
        groundSeen = ground.version;
      }
      // The first follow, or a building named since the filing was last asked for.
      if (version > 0 && pending.size === was && whole === wholeWas) return false;
      version++;
      return true;
    },
    solids() {
      if (whole) {
        /** @rebuild The whole town only when the diary cannot say what changed. */
        filing.clear();
        for (const b of buildings?.all() ?? []) filing.add(b, floorAt(b));
        whole = false;
      } else {
        for (const id of pending) {
          const b = buildings?.get(id);
          filing.remove(id);
          if (b) filing.add(b, floorAt(b));
        }
      }
      pending.clear();
      return filing;
    },
  };
}

const overlaps = (a: Rect, b: Rect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const cellKey = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);

/** The cells a volume's world box grown by the reach touches (its numbers at `o` in `page`), each told once. */
function forEachCellOf(page: Float64Array, o: number, visit: (key: number) => void): void {
  const bx = page[o + S_BX]!, by = page[o + S_BY]!, cos = page[o + S_COS]!, sin = page[o + S_SIN]!;
  const x0 = page[o + S_X0]!, y0 = page[o + S_Y0]!, x1 = page[o + S_X1]!, y1 = page[o + S_Y1]!;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let corner = 0; corner < 4; corner++) {
    const lx = corner === 0 || corner === 3 ? x0 : x1;
    const ly = corner < 2 ? y0 : y1;
    const wx = bx + lx * cos - ly * sin;
    const wy = by + lx * sin + ly * cos;
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
  }
  for (let cx = Math.floor((minX - REACH) / CELL); cx <= Math.floor((maxX + REACH) / CELL); cx++) {
    for (let cy = Math.floor((minY - REACH) / CELL); cy <= Math.floor((maxY + REACH) / CELL); cy++) visit(cellKey(cx, cy));
  }
}

/** The solid volumes filed by cell (their slots in `SolidPages`), each building's taken out and filed again on its own. */
class SolidFiling implements CameraSolids {
  private readonly pages = new SolidPages();
  private readonly cells = new Map<number, number[]>();
  /** DO NOT keep each building's record and arrays of its slots and cells (a `Map` entry, a record held decoded and two arrays a building of the map): its first volume's slot by its id, in a column (`IdSlots`), the rest chained in the pages (`S_NEXT`), its cells worked out again from its volumes' boxes when it is taken out. */
  private readonly filedIds = new IdSlots(1024);
  private first = new Int32Array(16);

  constructor() {
    this.filedIds.onGrow = (n) => { this.first = grown(this.first, n); };
  }

  clear(): void {
    this.cells.clear();
    this.filedIds.clear();
    this.pages.clear();
  }

  /** `b`'s solid volumes filed, standing on `foot`. */
  add(b: Building, foot: number): void {
    const cos = Math.cos(b.rotation);
    const sin = Math.sin(b.rotation);
    let head = -1, last = -1;
    // A building carved by a void or an intersection hides nothing for sure: its masses' union is not its solid.
    const carved = b.volumes.some((v) => !v.open && !isMass(v));
    for (const v of b.volumes) {
      if (v.open || !isMass(v)) continue;
      const solid = this.pages.take();
      const page = this.pages.page(solid), o = at(solid);
      const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
      page[o + S_BX] = b.x; page[o + S_BY] = b.y; page[o + S_COS] = cos; page[o + S_SIN] = sin;
      page[o + S_X0] = x0; page[o + S_Y0] = y0; page[o + S_X1] = x1; page[o + S_Y1] = y1;
      page[o + S_FOOT] = foot; page[o + S_TOP] = foot + volumeHeight(b, v) + roofRise(b, v) + CLEARANCE;
      // Its walls, drawn in by the deepest relief pushed into them: what surely stands (its roof left out, a ridge hides less than its box).
      let inset = OCCLUDER_MARGIN;
      for (const r of v.reliefs ?? []) if (r.depth < 0) inset = Math.max(inset, -r.depth + OCCLUDER_MARGIN);
      const solidWalls = !carved && !v.outline && v.w > 2 * inset && v.d > 2 * inset && v.storeys.length > 0;
      page[o + S_WALL0] = solidWalls ? foot + Math.max(0, volumeElevation(b, v, v.base)) : NaN;
      page[o + S_WALL1] = solidWalls ? foot + volumeElevation(b, v, volumeTop(v)) : NaN;
      page[o + S_INSET] = inset;
      page[o + S_NEXT] = -1;
      if (last >= 0) this.pages.page(last)[at(last) + S_NEXT] = solid; else head = solid;
      last = solid;
      // The world box of the volume grown by the reach, filed in every cell it touches.
      forEachCellOf(page, o, (k) => {
        const list = this.cells.get(k);
        if (list) list.push(solid);
        else this.cells.set(k, [solid]);
      });
    }
    if (head < 0) return;
    // Its slot taken first: taking it may grow the column (`onGrow`).
    const filed = this.filedIds.take(b.id);
    this.first[filed] = head;
  }

  /** The building's solids taken out of their cells. */
  remove(id: BuildingId): void {
    const filed = this.filedIds.get(id);
    if (filed < 0) return;
    for (let slot = this.first[filed]!; slot >= 0;) {
      const page = this.pages.page(slot), o = at(slot);
      forEachCellOf(page, o, (k) => {
        const list = this.cells.get(k);
        if (!list) return;
        const i = list.indexOf(slot);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.cells.delete(k);
      });
      const next = page[o + S_NEXT]!;
      this.pages.give(slot);
      slot = next;
    }
    this.filedIds.delete(id);
  }

  forEachIn(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void {
    this.pages.walk();
    this.visitCells(x0, y0, x1, y1, visit);
  }

  forEachInAny(rects: readonly Rect[], visit: SolidVisit): void {
    this.pages.walk();
    for (let i = 0; i < rects.length; i++) { const box = rects[i]!; this.visitCells(box[0], box[1], box[2], box[3], visit); }
  }

  /** The slots filed over a rectangle not yet met in this walk. */
  private visitCells(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const slot of list) {
          if (!this.pages.visitOnce(slot)) continue;
          const p = this.pages.page(slot), o = at(slot);
          visit(p[o + S_BX]!, p[o + S_BY]!, p[o + S_COS]!, p[o + S_SIN]!, p[o + S_X0]!, p[o + S_Y0]!, p[o + S_X1]!, p[o + S_Y1]!, p[o + S_TOP]! - CLEARANCE);
        }
      }
    }
  }

  forEachOccluder(x0: number, y0: number, x1: number, y1: number, visit: OccluderVisit): void {
    this.pages.walk();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const slot of list) {
          const p = this.pages.page(slot), o = at(slot);
          const bottom = p[o + S_WALL0]!;
          if (Number.isNaN(bottom) || !this.pages.visitOnce(slot)) continue;
          const inset = p[o + S_INSET]!;
          visit(p[o + S_BX]!, p[o + S_BY]!, p[o + S_COS]!, p[o + S_SIN]!, p[o + S_X0]! + inset, p[o + S_Y0]! + inset, p[o + S_X1]! - inset, p[o + S_Y1]! - inset, bottom, p[o + S_WALL1]!);
        }
      }
    }
  }

  floorAt(x: number, y: number): number {
    return lowestEye(this.pages, this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, REACH);
  }

  roofAt(x: number, y: number): number {
    const eye = lowestEye(this.pages, this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, 0);
    return eye === -Infinity ? eye : eye - CLEARANCE;
  }
}

/** The lowest the eye may stand at (x, y) over `list`, its floor easing down over `reach` round each volume. */
function lowestEye(pages: SolidPages, list: readonly number[] | undefined, x: number, y: number, reach: number): number {
  let floor = -Infinity;
  if (!list) return floor;
  for (const slot of list) {
    const p = pages.page(slot), o = at(slot);
    const top = p[o + S_TOP]!;
    if (top <= floor) continue;
    const cos = p[o + S_COS]!, sin = p[o + S_SIN]!;
    const dx = x - p[o + S_BX]!, dy = y - p[o + S_BY]!;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const ox = Math.max(p[o + S_X0]! - lx, 0, lx - p[o + S_X1]!);
    const oy = Math.max(p[o + S_Y0]! - ly, 0, ly - p[o + S_Y1]!);
    const d = Math.hypot(ox, oy);
    if (reach === 0 ? d > 0 : d >= reach) continue;
    floor = Math.max(floor, reach === 0 ? top : top - (top - p[o + S_FOOT]!) * smoothstep(d / reach));
  }
  return floor;
}
