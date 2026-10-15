import { m } from '@world/units';
import { isMass, roofRise, volumeHeight } from './geometry';
import { BuildingStore } from './store';
import type { Building, BuildingId } from './types';

/** THE LOWEST THE CAMERA'S EYE MAY STAND OVER THE BUILDINGS, a continuous function of the map point */

/** How far over a roof the eye keeps, world units. */
const CLEARANCE = m(1);
/** How far round a volume its floor eases down to the building's foot, world units: the camera's radius */
const REACH = m(2);
/** The grid the volumes are filed in, world units a cell. */
const CELL = m(40);

/** DO NOT go back to an object per volume and a set per building: 29 MB of a city of 5 400. */
const STRIDE = 10;
const S_BX = 0, S_BY = 1, S_COS = 2, S_SIN = 3, S_X0 = 4, S_Y0 = 5, S_X1 = 6, S_Y1 = 7, S_FOOT = 8, S_TOP = 9;
const PAGE_BITS = 12;
const PAGE = 1 << PAGE_BITS;

class SolidPages {
  private pages: Float64Array[] = [];
  private free: number[] = [];
  private next = 0;

  /** A slot for one volume, from the free list or a new one (a page added when it is the first of one). */
  take(): number {
    const slot = this.free.pop() ?? this.next++;
    while (this.pages.length <= slot >>> PAGE_BITS) this.pages.push(new Float64Array(PAGE * STRIDE));
    return slot;
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
  /** Every solid volume filed in the cells over a map rectangle, as its building's frame */
  forEachIn(x0: number, y0: number, x1: number, y1: number,
    visit: (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void): void;
}

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
  /** Buildings to file again at the next ask, or the whole town; those whose floor the ground moved under, apart. */
  const pending = new Set<BuildingId>();
  const groundMoved = new Set<BuildingId>();
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
          for (const b of town.nearAny(rects, reach, (b, r) => overlaps(boxOf(b), r))) { pending.add(b.id); groundMoved.add(b.id); }
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
          // Named by the diary again with the record filed and no ground moved under it: as it stands.
          if (b && filing.recordOf(id) === b && !groundMoved.has(id)) continue;
          filing.remove(id);
          if (b) filing.add(b, floorAt(b));
        }
      }
      pending.clear();
      groundMoved.clear();
      return filing;
    },
  };
}

const overlaps = (a: Rect, b: Rect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const cellKey = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);

/** The solid volumes filed by cell (their slots in `SolidPages`), each building's taken out and filed again on its own. */
class SolidFiling implements CameraSolids {
  private readonly pages = new SolidPages();
  private readonly cells = new Map<number, number[]>();
  /** Each building's record filed, its volumes' slots and the cells they are filed in. */
  private readonly filed = new Map<BuildingId, { readonly b: Building; readonly slots: readonly number[]; readonly keys: readonly number[] }>();

  clear(): void {
    this.cells.clear();
    this.filed.clear();
    this.pages.clear();
  }

  /** `b`'s solid volumes filed, standing on `foot`. */
  add(b: Building, foot: number): void {
    const cos = Math.cos(b.rotation);
    const sin = Math.sin(b.rotation);
    const slots: number[] = [];
    const keys: number[] = [];
    for (const v of b.volumes) {
      if (v.open || !isMass(v)) continue;
      const solid = this.pages.take();
      const page = this.pages.page(solid), o = at(solid);
      const x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
      page[o + S_BX] = b.x; page[o + S_BY] = b.y; page[o + S_COS] = cos; page[o + S_SIN] = sin;
      page[o + S_X0] = x0; page[o + S_Y0] = y0; page[o + S_X1] = x1; page[o + S_Y1] = y1;
      page[o + S_FOOT] = foot; page[o + S_TOP] = foot + volumeHeight(b, v) + roofRise(b, v) + CLEARANCE;
      slots.push(solid);
      // The world box of the volume grown by the reach, filed in every cell it touches.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let corner = 0; corner < 4; corner++) {
        const lx = corner === 0 || corner === 3 ? x0 : x1;
        const ly = corner < 2 ? y0 : y1;
        const wx = b.x + lx * cos - ly * sin;
        const wy = b.y + lx * sin + ly * cos;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
      }
      for (let cx = Math.floor((minX - REACH) / CELL); cx <= Math.floor((maxX + REACH) / CELL); cx++) {
        for (let cy = Math.floor((minY - REACH) / CELL); cy <= Math.floor((maxY + REACH) / CELL); cy++) {
          const k = cellKey(cx, cy);
          const list = this.cells.get(k);
          if (list) list.push(solid);
          else this.cells.set(k, [solid]);
          keys.push(k);
        }
      }
    }
    this.filed.set(b.id, { b, slots, keys });
  }

  /** The record a building was filed as. */
  recordOf(id: BuildingId): Building | undefined {
    return this.filed.get(id)?.b;
  }

  /** The building's solids taken out of their cells. */
  remove(id: BuildingId): void {
    const known = this.filed.get(id);
    if (!known) return;
    for (const k of known.keys) {
      const list = this.cells.get(k);
      if (!list) continue; // a cell two of its volumes are filed in, already emptied of them
      const kept = list.filter((slot) => !known.slots.includes(slot));
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    for (const slot of known.slots) this.pages.give(slot);
    this.filed.delete(id);
  }

  forEachIn(x0: number, y0: number, x1: number, y1: number,
    visit: (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void): void {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const slot of this.cells.get(cellKey(cx, cy)) ?? []) {
          const p = this.pages.page(slot), o = at(slot);
          visit(p[o + S_BX]!, p[o + S_BY]!, p[o + S_COS]!, p[o + S_SIN]!, p[o + S_X0]!, p[o + S_Y0]!, p[o + S_X1]!, p[o + S_Y1]!, p[o + S_TOP]! - CLEARANCE);
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
