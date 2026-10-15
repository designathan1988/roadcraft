import type { Vec2 } from '@core/vec2';

/** Vehicle bodies as oriented rectangles, for the turn-path sweep (`turnPaths.ts`) */

export interface Rect { cx: number; cy: number; ux: number; uy: number; hl: number; hw: number; r: number }

export const rect = (p: Vec2, t: Vec2, length: number, width: number): Rect =>
  ({ cx: p.x, cy: p.y, ux: t.x, uy: t.y, hl: length / 2, hw: width / 2, r: Math.hypot(length, width) / 2 });

/** Separating-axis test between two oriented rectangles. */
export function overlap(a: Rect, b: Rect): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (dx * dx + dy * dy > (a.r + b.r) * (a.r + b.r)) return false;
  return !separatedOn(a, b, dx, dy, a.ux, a.uy) && !separatedOn(a, b, dx, dy, -a.uy, a.ux)
    && !separatedOn(a, b, dx, dy, b.ux, b.uy) && !separatedOn(a, b, dx, dy, -b.uy, b.ux);
}

/** Whether the axis (ax, ay) separates the two rectangles `dx, dy` apart. */
function separatedOn(a: Rect, b: Rect, dx: number, dy: number, ax: number, ay: number): boolean {
  const d = Math.abs(dx * ax + dy * ay);
  const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
  const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
  return d >= ra + rb;
}

/** The car bodies standing in one waiting lane, and the box their centres span */
export interface Queue {
  readonly bodies: readonly Rect[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Bounding radius of every body in it (they are all one size). */
  readonly r: number;
}

/** A queue of same-sized bodies (`r`, their bounding radius) and the box of their centres. */
export function queueOf(bodies: readonly Rect[], r: number): Queue {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const body of bodies) {
    minX = Math.min(minX, body.cx); maxX = Math.max(maxX, body.cx);
    minY = Math.min(minY, body.cy); maxY = Math.max(maxY, body.cy);
  }
  return { bodies, minX, minY, maxX, maxY, r };
}

/** Whether `body` is certainly clear of every body in `queue` by `overlap`'s own first test, the bounding circles. */
export function clearOfQueue(body: Rect, queue: Queue): boolean {
  const gx = body.cx < queue.minX ? queue.minX - body.cx : body.cx > queue.maxX ? body.cx - queue.maxX : 0;
  const gy = body.cy < queue.minY ? queue.minY - body.cy : body.cy > queue.maxY ? body.cy - queue.maxY : 0;
  const reach = body.r + queue.r;
  return gx * gx + gy * gy > reach * reach;
}
