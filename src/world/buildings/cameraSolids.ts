import { m } from '@world/units';
import { isMass, roofRise, volumeHeight } from './geometry';
import { BuildingStore } from './store';
import type { Building, BuildingId } from './types';

/**
 * THE LOWEST THE CAMERA'S EYE MAY STAND OVER THE BUILDINGS, a continuous
 * function of the map point (`render/isoViewport.ts` `setSolids`).
 *
 * Over each solid volume it is the volume's roof plus a clearance; round it,
 * within `REACH`, it eases down to the building's floor. The rig pulls the
 * eye forward along its line of sight until it is clear of this floor
 * (Cinemachine's Deoccluder, "Pull Camera Forward", with a small camera
 * radius), so the camera is never inside the walls; a continuous floor, so
 * the pull is too.
 */

/** How far over a roof the eye keeps, world units. */
const CLEARANCE = m(1);
/**
 * How far round a volume its floor eases down to the building's foot, world
 * units: the camera's radius (Cinemachine's "Camera Radius", kept small). The
 * rig pulls the eye forward out of this, so a street between towers stays
 * open to the camera.
 */
const REACH = m(2);
/** The grid the volumes are filed in, world units a cell. */
const CELL = m(40);

interface Solid {
  /** The building's frame. */
  readonly bx: number;
  readonly by: number;
  readonly cos: number;
  readonly sin: number;
  /** The volume's box, in the building's frame. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** World heights: the building's floor and the eye's floor over the roof. */
  readonly foot: number;
  readonly top: number;
}

export interface CameraSolids {
  /** The lowest the eye may stand at (x, y), world height; -Infinity away from every building. */
  floorAt(x: number, y: number): number;
  /**
   * The roof over (x, y) when the point is inside a solid volume's plan (its
   * highest, no margin round it), world height; -Infinity outside every one:
   * where the point the camera looks at goes when it falls inside a building.
   */
  roofAt(x: number, y: number): number;
  /**
   * Every solid volume filed in the cells over a map rectangle, as its
   * building's frame (origin, cos, sin), its box in that frame and its roof's
   * world height (no clearance): for the light the town shuts out of its
   * streets (`render/canyonLight.ts`). A volume over several cells comes more
   * than once.
   */
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

/**
 * The town's solids as filed for the camera (`render/renderer.ts` asks them
 * every frame, `canyonLight.ts` reads the same filing). Out of the renderer so
 * the work of one building more can be counted (`tests/scale/buildingEdit.spec.ts`).
 */
export interface CameraSolidsKeeper {
  /** Moves whenever the filing changed: what the canyon light's picture stands for. */
  readonly key: string;
  /** Takes in the buildings and the ground; true when the filing changed since the last `follow`. */
  follow(buildings: BuildingStore, ground: GroundSince): boolean;
  /** The filing, brought up to the last `follow` on the first ask after it. */
  solids(): CameraSolids;
}

/**
 * A keeper of the camera's solids, filed once and kept: a building the diary
 * names (`BuildingStore.changedSince`) is taken out of its cells and filed
 * again, and so is each building whose `boxOf` a change of the ground reached
 * (found by place, `BuildingStore.near` over the change grown by `reach`, how
 * far `boxOf` goes past a building's own bounds) - Nystrom, "Spatial
 * Partition": an object that moves leaves its cell and enters the new one, the
 * grid is not built again. The whole town is filed only when the diary cannot
 * say what changed (the first ask, a map opened).
 * DO NOT file the town again for one building: keyed on the store's revision,
 * every building grown filed the whole town again in the next frame (16 s of a
 * 2,560 m city's growth, 2026-10-14). `floorAt` is a building's ground-floor
 * world height on the ground as it stands.
 */
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
          for (const r of rects) {
            for (const b of town.near(r[0] - reach, r[1] - reach, r[2] + reach, r[3] + reach)) {
              if (overlaps(boxOf(b), r)) { pending.add(b.id); groundMoved.add(b.id); }
            }
          }
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

/** Files every solid volume of `buildings`; `floorOf` gives each one's ground-floor world height. */
export function cameraSolids(buildings: Iterable<Building>, floorOf: (b: Building) => number): CameraSolids {
  const filing = new SolidFiling();
  for (const b of buildings) filing.add(b, floorOf(b));
  return filing;
}

const cellKey = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);

/** The solid volumes filed by cell, each building's taken out and filed again on its own. */
class SolidFiling implements CameraSolids {
  private readonly cells = new Map<number, Solid[]>();
  /** Each building's record filed, its solids and the cells they are filed in. */
  private readonly filed = new Map<BuildingId, { readonly b: Building; readonly solids: ReadonlySet<Solid>; readonly keys: readonly number[] }>();

  clear(): void {
    this.cells.clear();
    this.filed.clear();
  }

  /** `b`'s solid volumes filed, standing on `foot`. */
  add(b: Building, foot: number): void {
    const cos = Math.cos(b.rotation);
    const sin = Math.sin(b.rotation);
    const solids = new Set<Solid>();
    const keys: number[] = [];
    for (const v of b.volumes) {
      if (v.open || !isMass(v)) continue;
      const solid: Solid = {
        bx: b.x, by: b.y, cos, sin,
        x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.d,
        foot, top: foot + volumeHeight(b, v) + roofRise(b, v) + CLEARANCE,
      };
      solids.add(solid);
      // The world box of the volume grown by the reach, filed in every cell it touches.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [lx, ly] of [[solid.x0, solid.y0], [solid.x1, solid.y0], [solid.x1, solid.y1], [solid.x0, solid.y1]] as const) {
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
    this.filed.set(b.id, { b, solids, keys });
  }

  /** The record a building was filed as. */
  recordOf(id: BuildingId): Building | undefined {
    return this.filed.get(id)?.b;
  }

  /** The building's solids taken out of their cells. */
  remove(id: BuildingId): void {
    const known = this.filed.get(id);
    if (!known) return;
    for (const k of new Set(known.keys)) {
      const kept = this.cells.get(k)!.filter((s) => !known.solids.has(s));
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    this.filed.delete(id);
  }

  forEachIn(x0: number, y0: number, x1: number, y1: number,
    visit: (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void): void {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const s of this.cells.get(cellKey(cx, cy)) ?? []) visit(s.bx, s.by, s.cos, s.sin, s.x0, s.y0, s.x1, s.y1, s.top - CLEARANCE);
      }
    }
  }

  floorAt(x: number, y: number): number {
    return lowestEye(this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, REACH);
  }

  roofAt(x: number, y: number): number {
    const eye = lowestEye(this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, 0);
    return eye === -Infinity ? eye : eye - CLEARANCE;
  }
}

/** The lowest the eye may stand at (x, y) over `list`, its floor easing down over `reach` round each volume. */
function lowestEye(list: readonly Solid[] | undefined, x: number, y: number, reach: number): number {
  let floor = -Infinity;
  for (const s of list ?? []) {
    if (s.top <= floor) continue;
    const dx = x - s.bx, dy = y - s.by;
    const lx = dx * s.cos + dy * s.sin;
    const ly = -dx * s.sin + dy * s.cos;
    const ox = Math.max(s.x0 - lx, 0, lx - s.x1);
    const oy = Math.max(s.y0 - ly, 0, ly - s.y1);
    const d = Math.hypot(ox, oy);
    if (reach === 0 ? d > 0 : d >= reach) continue;
    floor = Math.max(floor, reach === 0 ? s.top : s.top - (s.top - s.foot) * smoothstep(d / reach));
  }
  return floor;
}
