import type { Vec2 } from '@core/vec2';
import { localToWorld, solidFootprints, worldToLocal } from '@world/buildings/geometry';
import type { Building, BuildingElement, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { streetDoors } from '@world/buildings/streetDoors';
import { carGates } from './parking';
import { PEOPLE_GRID, buildLotGrid, sees, wayOut } from './lotNav';

/**
 * The way on foot between a lot's front door and the footway: from the door,
 * down the path to the people's gate in the front boundary, through the gate
 * and out onto the footway (`editor/lotPlan.ts` puts the gate on the path to
 * the door, the same x as the door, in every front with a garden or a
 * forecourt). As SUMO reaches a stop off the lane by its `<access>` (a lane, a
 * position on it, and the distance walked to the stop), the gate's foot on the
 * footway is where a walk from the street turns in, and the way through the
 * lot is walked as one more stretch of the route (`agents/walk.ts`, steps off
 * the walkways).
 *
 * Inside the lot the way is found on a person's grid (`lotNav.ts`
 * `PEOPLE_GRID`): the building, walls, fences, hedges, trees, benches, bins,
 * the car stalls are solid, stairs and ramps are not; the gate must be open to
 * that grid (a line from inside it to the footway crosses only free cells),
 * and the way is pulled taut. The last stretch runs square through the
 * middle of the gate, between its posts.
 *
 * Worked out once per building record (records are replaced on any change)
 * and only when a walker is first sent to or from that lot.
 */

/** A lot's way on foot, world units. */
export interface DoorWay {
  readonly building: BuildingId;
  /** From the door, through the gate, to the gate's foot on the footway. */
  readonly out: readonly Vec2[];
  /** The lot's width along the street, u: how much street it fronts. */
  readonly frontage: number;
  /**
   * The way is a street door's step (`streetWay`), not a gate's: whether its
   * foot is on a footway depends on the roads, which the building record
   * does not follow - its user checks it (`ambient.ts`, `walk.ts` `joinsFootway`).
   */
  readonly street?: true;
}

/** A gate narrower than a car's is a person's (`parking.ts` CAR_GATE). */
export function personGates(b: Building): BuildingElement[] {
  const cars = new Set(carGates(b));
  return (b.elements ?? []).filter((el) => el.kind === 'gate' && !cars.has(el));
}

/** Farthest a door may be behind its gate. */
const DOOR_REACH = m(40);
/** Where the door's walker stands: this far in front of the wall. */
const DOOR_OFF = m(0.45);
/** Inside the gate, the point the way runs square through it from; outside, its foot on the footway. */
const GATE_IN = m(1.5);
const GATE_OUT = m(0.6);
/** Room round the gate and the door the grid covers. */
const MARGIN = m(3);

const DOORS = new WeakMap<Building, DoorWay | null>();

/** The building's way from its door out through its people's gate; null when it has none that is walkable. */
export function doorWay(b: Building): DoorWay | null {
  const known = DOORS.get(b);
  if (known !== undefined) return known;
  const way = workOut(b);
  DOORS.set(b, way);
  return way;
}

function workOut(b: Building): DoorWay | null {
  const gates = personGates(b);
  if (!gates.length) return streetWay(b);
  const rings = solidFootprints(b).map((ring) => ring.map((p) => worldToLocal(b, p)));
  if (!rings.length) return null;
  // The building's middle, for which way is into the lot.
  let cx = 0, cy = 0, n = 0;
  for (const ring of rings) for (const p of ring) { cx += p.x; cy += p.y; n++; }
  cx /= n; cy /= n;
  for (const g of gates) {
    const alongY = g.facing === 1 || g.facing === 3;
    let ux = alongY ? 0 : 1, uy = alongY ? 1 : 0;
    if (g.angle) {
      const c = Math.cos(g.angle), s = Math.sin(g.angle);
      [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
    }
    let nx = -uy, ny = ux;
    if ((cx - g.x) * nx + (cy - g.y) * ny < 0) { nx = -nx; ny = -ny; }
    // The door: where the line square through the gate meets the building.
    const t = hitRings(rings, g.x, g.y, nx, ny);
    if (t === null || t > DOOR_REACH || t < DOOR_OFF + m(0.5)) continue;
    const door = { x: g.x + nx * (t - DOOR_OFF), y: g.y + ny * (t - DOOR_OFF) };
    const inner = { x: g.x + nx * Math.min(GATE_IN, (t - DOOR_OFF) / 2), y: g.y + ny * Math.min(GATE_IN, (t - DOOR_OFF) / 2) };
    const outer = { x: g.x - nx * GATE_OUT, y: g.y - ny * GATE_OUT };
    const xs = [door.x, outer.x], ys = [door.y, outer.y];
    const rect = {
      x: Math.min(...xs) - MARGIN, y: Math.min(...ys) - MARGIN,
      w: Math.max(...xs) - Math.min(...xs) + 2 * MARGIN, d: Math.max(...ys) - Math.min(...ys) + 2 * MARGIN,
    };
    // The gate open to a person: the line from inside it to its foot outside crosses only free cells.
    const grid = buildLotGrid(b, rect, rings, [{ inner, edge: outer }], PEOPLE_GRID);
    if (!sees(grid, inner, outer)) continue;
    const found = wayOut(grid, door.x, door.y);
    if (!found) continue;
    const local = [...found.points, inner, { x: g.x, y: g.y }, outer]
      .filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1]!.x, p.y - all[i - 1]!.y) > m(0.3));
    // How much street the lot fronts: its blocks' width along the gate.
    let lo = Infinity, hi = -Infinity;
    for (const v of b.volumes) {
      for (const [x, y] of [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.d], [v.x + v.w, v.y + v.d]] as const) {
        const a = (x - g.x) * ux + (y - g.y) * uy;
        lo = Math.min(lo, a); hi = Math.max(hi, a);
      }
    }
    return { building: b.id, out: local.map((p) => localToWorld(b, p.x, p.y)), frontage: Math.max(m(6), hi - lo) };
  }
  return null;
}

/**
 * A shop or a bar built up to the footway, with no people's gate: its front
 * door opens onto the street (`world/buildings/streetDoors.ts`), and the way
 * is the step out of it - from where the door's walker stands to its foot on
 * the footway. Without it nobody went into a shop on the footway.
 */
function streetWay(b: Building): DoorWay | null {
  const d = streetDoors(b)[0];
  if (!d) return null;
  const out = [
    { x: d.x + d.nx * DOOR_OFF, y: d.y + d.ny * DOOR_OFF },
    { x: d.x + d.nx * (DOOR_OFF + GATE_OUT), y: d.y + d.ny * (DOOR_OFF + GATE_OUT) },
  ];
  // How much street the lot fronts: its blocks' width along the facade (local x).
  let lo = Infinity, hi = -Infinity;
  for (const v of b.volumes) { lo = Math.min(lo, v.x); hi = Math.max(hi, v.x + v.w); }
  return { building: b.id, out, frontage: Math.max(m(6), hi - lo), street: true };
}

/** Distance along the ray from (x, y) in (dx, dy) to the nearest side of the rings; null when it meets none. */
function hitRings(rings: readonly (readonly Vec2[])[], x: number, y: number, dx: number, dy: number): number | null {
  let best: number | null = null;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!, c = ring[i]!;
      const ex = c.x - a.x, ey = c.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - x) * ey - (a.y - y) * ex) / den;
      const u = ((a.x - x) * dy - (a.y - y) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
    }
  }
  return best;
}
