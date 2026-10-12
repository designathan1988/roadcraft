import { m } from '@world/units';
import { isMass, roofRise, volumeHeight } from './geometry';
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
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

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
    floorAt(x, y) {
      const list = cells.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
      if (!list) return -Infinity;
      let floor = -Infinity;
      for (const s of list) {
        if (s.top <= floor) continue;
        const dx = x - s.bx, dy = y - s.by;
        const lx = dx * s.cos + dy * s.sin;
        const ly = -dx * s.sin + dy * s.cos;
        const ox = Math.max(s.x0 - lx, 0, lx - s.x1);
        const oy = Math.max(s.y0 - ly, 0, ly - s.y1);
        const d = Math.hypot(ox, oy);
        if (d >= REACH) continue;
        floor = Math.max(floor, s.top - (s.top - s.foot) * smoothstep(d / REACH));
      }
      return floor;
    },
  };
}
