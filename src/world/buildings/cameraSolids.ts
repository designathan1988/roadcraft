import { m } from '@world/units';
import { isMass, roofRise, volumeHeight } from './geometry';
import type { BuildingStore } from './store';
import type { Building } from './types';

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

/**
 * The town's solids as filed for the camera, kept while the buildings and the
 * ground stand (`render/renderer.ts` asks it every frame, `canyonLight.ts`
 * reads the same filing). `follow` says whether the filing is new; it is made
 * only when first asked (`solids`), and each record's floor is kept while the
 * record and the ground are the same. Out of the renderer so the work of one
 * building more can be counted (`tests/scale/buildingEdit.spec.ts`).
 */
export interface CameraSolidsKeeper {
  /** What the filing stands for: the buildings' revision and the ground's. */
  readonly key: string;
  /** Takes in the buildings and the ground (`groundKey`); true when the filing is no longer the one handed out. */
  follow(buildings: BuildingStore, groundKey: string): boolean;
  /** The filing for the last `follow`, made on the first ask. */
  solids(): CameraSolids;
}

/** A keeper of the camera's solids; `floorAt` is a building's ground-floor world height on the ground as it stands. */
export function cameraSolidsKeeper(floorAt: (b: Building) => number): CameraSolidsKeeper {
  const floors = new WeakMap<Building, { key: string; floor: number }>();
  let key = '';
  let groundKey = '';
  let buildings: BuildingStore | null = null;
  let filed: CameraSolids | null = null;
  const floorOf = (b: Building): number => {
    const known = floors.get(b);
    if (known && known.key === groundKey) return known.floor;
    const floor = floorAt(b);
    floors.set(b, { key: groundKey, floor });
    return floor;
  };
  return {
    get key() { return key; },
    follow(town, ground) {
      buildings = town;
      const next = `${town.revision}:${ground}`;
      if (next === key) return false;
      key = next;
      groundKey = ground;
      filed = null;
      return true;
    },
    solids() {
      if (!filed) {
        const t0 = performance.now();
        filed = cameraSolids(buildings?.all() ?? [], floorOf);
        performance.measure('camera:solids', { start: t0 });
      }
      return filed;
    },
  };
}

/** Files every solid volume of `buildings`; `floorOf` gives each one's ground-floor world height. */
export function cameraSolids(buildings: Iterable<Building>, floorOf: (b: Building) => number): CameraSolids {
  const cells = new Map<number, Solid[]>();
  const key = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);
  for (const b of buildings) {
    const foot = floorOf(b);
    const cos = Math.cos(b.rotation);
    const sin = Math.sin(b.rotation);
    for (const v of b.volumes) {
      if (v.open || !isMass(v)) continue;
      const solid: Solid = {
        bx: b.x, by: b.y, cos, sin,
        x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.d,
        foot, top: foot + volumeHeight(b, v) + roofRise(b, v) + CLEARANCE,
      };
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
          const k = key(cx, cy);
          const list = cells.get(k);
          if (list) list.push(solid);
          else cells.set(k, [solid]);
        }
      }
    }
  }
  return {
    forEachIn(x0, y0, x1, y1, visit) {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          for (const s of cells.get(key(cx, cy)) ?? []) visit(s.bx, s.by, s.cos, s.sin, s.x0, s.y0, s.x1, s.y1, s.top - CLEARANCE);
        }
      }
    },
    floorAt(x, y) {
      return lowestEye(cells.get(key(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, REACH);
    },
    roofAt(x, y) {
      const eye = lowestEye(cells.get(key(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, 0);
      return eye === -Infinity ? eye : eye - CLEARANCE;
    },
  };
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
