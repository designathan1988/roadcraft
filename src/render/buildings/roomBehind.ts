import { localFootprint } from '@world/buildings/footprints';
import { FURNITURE_KINDS, type FloorInterior } from '@world/buildings/interior';
import type { Building, Volume } from '@world/buildings/types';
import { m } from '@world/units';

/** THE ROOM BEHIND A WINDOW, as the building's own interior has it (`interiorAt`, the rooms the cut-open view draws) */
export const ROOM_FLOATS = 12;

/** The farthest a wall is looked for: past it the room is closed at this depth. */
const MOST_DEEP = m(12);
const MOST_WIDE = m(10);
/** How far inside the wall the side walls are looked for. */
const INSIDE = m(0.5);
/** What a pane shows as its piece: the solid ones, that read as a box from across a room */
function seen(kind: string): boolean {
  switch (kind) {
    case 'bed': case 'singleBed': case 'sofa': case 'armchair': case 'shelf': case 'bookshelf': case 'counter': case 'fridge':
    case 'stove': case 'sink': case 'bath': case 'wardrobe': case 'pew': case 'wardBed': case 'altar': case 'machine': case 'rack':
    case 'locker': case 'atm': case 'stage': case 'barCounter': case 'checkout': case 'pallet':
      return true;
    default:
      return false;
  }
}

/** Where a ray (origin, unit direction) first crosses one of the segments (x0, y0, x1, y1 each), or `far`. */
function firstHit(walls: readonly number[], ox: number, oy: number, dx: number, dy: number, far: number): number {
  let best = far;
  for (let i = 0; i < walls.length; i += 4) {
    const ax = walls[i]!, ay = walls[i + 1]!, ex = walls[i + 2]! - ax, ey = walls[i + 3]! - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
    const s = ((ax - ox) * dy - (ay - oy) * dx) / den;
    if (t > 1e-3 && t < best && s >= -1e-6 && s <= 1 + 1e-6) best = t;
  }
  return best;
}

/** A floor's finish: 0 wood, 1 stone, 2 porcelain tiles. */
export type FloorKind = 0 | 1 | 2;

/** A storey's floor (`buildingMesh.ts` `emitInterior` and the windows alike): stone where people pass */
export function floorKind(b: Building, level: number): FloorKind {
  const homely = b.function === 'house' || b.function === 'townhouse' || b.function === 'apartments' ||
    b.function === 'residentialTower' || b.function === 'hotel' || (!b.function && b.use === 'residential');
  if (!(homely && level > 0 || b.function === 'house' || b.function === 'townhouse')) return 1;
  // One building's floors alike, picked from its id.
  return ((Math.imul(b.id + 7, 0x9e3779b1) >>> 0) % 10) < 3 ? 0 : 2;
}

/** The rooms of one block's storey seen from its facade */
export function roomsOfStorey(b: Building, v: Volume, inside: FloorInterior, level: number) {
  const walls: number[] = [];
  for (const p of inside.partitions) walls.push(p.x0, p.y0, p.x1, p.y1);
  const ring = localFootprint(v);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    walls.push(p.x, p.y, q.x, q.y);
  }
  const stone = floorKind(b, level);
  return (ax: number, ay: number, tx: number, ty: number, nx: number, ny: number, a: number, h: number, ceiling: number): number[] => {
    const px = ax + tx * a, py = ay + ty * a;
    const depth = Math.max(m(0.8), firstHit(walls, px - nx * m(0.02), py - ny * m(0.02), -nx, -ny, MOST_DEEP));
    const qx = px - nx * INSIDE, qy = py - ny * INSIDE;
    const back = Math.max(m(0.3), firstHit(walls, qx, qy, -tx, -ty, MOST_WIDE));
    const ahead = Math.max(m(0.3), firstHit(walls, qx, qy, tx, ty, MOST_WIDE));
    // The largest piece seen through the pane: in the room, the most of it across and up.
    let kind = -1, fh = 0, fc = 0, fhalf = 0, fnear = 0, ffar = 0, score = 0;
    for (const f of inside.furniture) {
      if (!seen(f.kind)) continue;
      const c = Math.cos(f.angle), s = Math.sin(f.angle);
      let a0 = Infinity, a1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const x = f.x + (cx * f.w * c - cy * f.d * s) / 2, y = f.y + (cx * f.w * s + cy * f.d * c) / 2;
        const along = (x - px) * tx + (y - py) * ty, deep = (px - x) * nx + (py - y) * ny;
        a0 = Math.min(a0, along); a1 = Math.max(a1, along); d0 = Math.min(d0, deep); d1 = Math.max(d1, deep);
      }
      if (a1 < -back || a0 > ahead || d1 < m(0.2) || d0 > depth) continue;
      a0 = Math.max(a0, -back); a1 = Math.min(a1, ahead); d0 = Math.max(d0, m(0.2)); d1 = Math.min(d1, depth);
      const shown = ((a1 - a0) * f.h) / (1 + Math.abs((a0 + a1) / 2) * 0.3);
      if (shown <= score) continue;
      score = shown;
      kind = FURNITURE_KINDS.indexOf(f.kind); fh = f.h; fc = (a0 + a1) / 2; fhalf = (a1 - a0) / 2; fnear = d0; ffar = d1;
    }
    // The pane's +x runs the facade's way or against it (its yaw turns +z out of the wall).
    const flip = -ny * tx + nx * ty < 0;
    return flip
      ? [ahead, back, depth, h, ceiling - h, stone, kind, fh, -fc, fhalf, fnear, ffar]
      : [back, ahead, depth, h, ceiling - h, stone, kind, fh, fc, fhalf, fnear, ffar];
  };
}
