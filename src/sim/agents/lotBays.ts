import { pointInPolygon } from '@core/polygon';
import { Polyline } from '@core/polyline';
import { localDirToWorld, localToWorld, worldToLocal } from '@world/buildings/geometry';
import type { BuildingElement, BuildingId, Volume } from '@world/buildings/types';
import type { Lanelet, LaneletId } from '@world/lanelets';
import type { SegmentId } from '@world/ids';
import { m, stepsIn } from '@world/units';
import { type LotGrid, type LotPart, buildLotGrid, wayOut } from './lotNav';
import { cellsMeet } from './laneGrid';
import type { Bay, BayLane } from './bay';

/** DO NOT read the world here but through `BayReads`: the worker has none. */

/** Width of one stall, as the lot planner lays them (2.5 x 5 m). */
const STALL = m(2.5);
/** A stall wider than this is a lorry's dock, not a car's bay. */
const LORRY_DOCK = m(3.2);
/** How far from a point the lane beside it is looked for (`laneBeside`), u. */
export const LANE_REACH = m(45);
/** Kept clear of the ends of a lane where a car joins or leaves it. */
const LANE_END = m(20);
/** The narrowest gate a car is driven through (a person's is 1.2 m); `parkingLayout.ts` `CAR_GATE_WIDTH`. */
const CAR_GATE = m(2.2);

/** What a lot's bays read of a block of its building (`bayRows`, `stallRoom`, `gatedProperty`). */
type LotBlock = Pick<Volume, 'x' | 'y' | 'w' | 'd' | 'open' | 'base'>;
/** What a lot's bays read of its building's record: its frame, its blocks' boxes and its parts. */
export interface LotRecord {
  readonly id: BuildingId;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly volumes: readonly LotBlock[];
  readonly elements?: readonly LotPart[];
}

/** What a lot's bays read of a lane: a `Lanelet`'s own fields, on the page or made again in a worker. */
export type BayLaneLine = Pick<Lanelet, 'id' | 'kind' | 'length' | 'segment' | 'centre'>;

/** A building's solid footprint, world frame, with its bounds. */
export interface WallRing {
  readonly building: BuildingId;
  readonly ring: readonly { x: number; y: number }[];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
}

/** Everything a lot's bays read of the world. */
export interface BayReads {
  /** The lanes whose bounds come within `reach` of a point, in id order (`LaneGrid.near`). */
  lanesNear(x: number, y: number, reach: number): readonly BayLaneLine[];
  /** Whether a lane is a ghost now (`SimWorld.rt`). */
  ghost(lane: LaneletId): boolean;
  /** Whether a street runs both ways (`RoadSegment.direction`). */
  bothWays(segment: SegmentId): boolean;
  /** The walls whose bounds meet a box. */
  wallsIn(x0: number, y0: number, x1: number, y1: number): readonly WallRing[];
}

/** Whether a body this long stands wholly inside the stall, parked centred in it. */
export function stallFits(bay: Pick<Bay, 'room'>, length: number): boolean {
  return length / 2 <= bay.room + FIT_EPS;
}
/** A body touching the stall's end is in it. */
const FIT_EPS = m(0.001);

/** Every part of a lot that a parked body may not stand in: what a car cannot drive through */
const STALL_BLOCKS: Readonly<Partial<Record<LotPart['kind'], true>>> = Object.freeze({
  wall: true, fence: true, hedge: true, railing: true, gate: true, pillar: true, stair: true, ramp: true, tree: true, bench: true,
  planter: true, rocks: true, clock: true, shrub: true, bin: true, lamp: true, bollard: true,
});
/** Parts this high off the ground or more stand over a parked body (a canopy, a sign). */
const OVER_A_BODY = m(2.1);
/** Half the widest body that parks in a stall (a van, 2 m) and a hand: the band a stall's clear length is read in. */
const STALL_BAND = m(1.05);

/** Half the clear length of a stall (local frame of its building): from its centre `(lx, ly)` along `(dx, dy)` */
function stallRoom(b: LotRecord, lx: number, ly: number, dx: number, dy: number, half: number): number {
  let room = half;
  const along = (ring: readonly (readonly [number, number])[]): void => {
    for (const sign of [1, -1]) {
      // The ring in the stall's frame: u along the stall (this end), v across.
      let poly = ring.map(([x, y]) => {
        const px = x - lx, py = y - ly;
        return [(px * dx + py * dy) * sign, -px * dy + py * dx] as [number, number];
      });
      poly = clip(poly, 1, -STALL_BAND);
      poly = clip(poly, -1, -STALL_BAND);
      poly = clip(poly, 0, 0);
      for (const [u] of poly) room = Math.min(room, Math.max(0, u));
    }
  };
  // Only what comes within the stall's reach is cut (a lot holds a hundred parts).
  const reach = Math.hypot(half, STALL_BAND);
  for (const el of b.elements ?? []) {
    if (!STALL_BLOCKS[el.kind] || el.z >= OVER_A_BODY) continue;
    const alongY = el.facing === 0 || el.facing === 2;
    const hx = (alongY ? el.w : el.d) / 2, hy = (alongY ? el.d : el.w) / 2;
    if (Math.hypot(el.x - lx, el.y - ly) > reach + Math.hypot(hx, hy)) continue;
    const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
    along([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([a, k]) => [el.x + a! * c - k! * s, el.y + a! * s + k! * c] as [number, number]));
  }
  for (const v of b.volumes) {
    if (v.open || v.base > 0) continue;
    if (Math.hypot(v.x + v.w / 2 - lx, v.y + v.d / 2 - ly) > reach + Math.hypot(v.w, v.d) / 2) continue;
    along([[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d]]);
  }
  return Math.max(0, room);
}

/** A convex ring cut to one side of a line of the stall's frame (Sutherland-Hodgman): `axis` 0 keeps u >= `at` */
function clip(poly: readonly [number, number][], axis: 0 | 1 | -1, at: number): [number, number][] {
  const val = (p: readonly [number, number]): number => (axis === 0 ? p[0] : axis === 1 ? p[1] : -p[1]) - at;
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, c = poly[(i + 1) % poly.length]!;
    const va = val(a), vc = val(c);
    if (va >= 0) out.push(a);
    if ((va >= 0) !== (vc >= 0)) {
      const t = va / (va - vc);
      out.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Clear of the corners of a lot where a car leaves it for the street. */
const EDGE_MARGIN = m(3.5);
/** How far inside the street edge the last turn is made. */
const EDGE_INSET = m(3);
/** Farthest a lot's street edge may be from the lane it opens onto. */
const EDGE_REACH = m(22);

/** A lot's stalls, each with the way out of its lot and the lane it is reached from (ids from 0). */
export function bayRows(r: BayReads, b: LotRecord): Bay[] {
  const out: Bay[] = [];
  const navCache = new Map<object, { exits: LotExit[]; grid: LotGrid }>();
  // A lot closed by a boundary with car gates (`editor/lotPlan.ts`)
  const property = gatedProperty(b);
  for (const el of b.elements ?? []) {
    if (el.kind !== 'parking') continue;
    const stalls = Math.max(1, Math.floor(el.w / STALL));
    // A lorry's dock at a works' loading doors (3.6 m), not a car's bay.
    if (el.w / stalls > LORRY_DOCK) continue;
    const alongY = el.facing === 0 || el.facing === 2;
    // `w` runs across the facing (the row of stalls), `d` along it (a stall's depth).
    let ax = alongY ? 0 : 1, ay = alongY ? 1 : 0;
    let cx = alongY ? 1 : 0, cy = alongY ? 0 : 1;
    if (el.angle) {
      const c = Math.cos(el.angle), s = Math.sin(el.angle);
      [ax, ay] = [ax * c - ay * s, ax * s + ay * c];
      [cx, cy] = [cx * c - cy * s, cx * s + cy * c];
    }
    const lot = property ?? b.volumes.find((v) => v.open && el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d);
    let nav = lot ? navCache.get(lot) : undefined;
    if (lot && !nav) {
      const exits = property ? gateExits(r, b, property) : exitsOf(r, b, lot);
      const local = wallsNear(r, b, lot).map((wl) => wl.ring.map((q) => worldToLocal(b, q)));
      nav = { exits, grid: buildLotGrid(b, lot, local, exits) };
      navCache.set(lot, nav);
    }
    for (let k = 0; k < stalls; k++) {
      const u = -el.w / 2 + (el.w * (k + 0.5)) / stalls;
      const lx = el.x + cx * u, ly = el.y + cy * u;
      const p = localToWorld(b, lx, ly);
      if (lot && nav) {
        // The stall opens on whichever side has an aisle that leads out of the lot
        const reach = el.d / 2 + m(2.8);
        let pick: { sign: number; points: { x: number; y: number }[]; exit: number; cost: number } | null = null;
        for (const sign of [1, -1]) {
          const aisle = { x: lx + ax * sign * reach, y: ly + ay * sign * reach };
          const way = wayOut(nav.grid, aisle.x, aisle.y);
          if (!way) continue;
          let cost = 0;
          for (let i = 1; i < way.points.length; i++) cost += Math.hypot(way.points[i]!.x - way.points[i - 1]!.x, way.points[i]!.y - way.points[i - 1]!.y);
          if (!pick || cost < pick.cost) pick = { sign, points: way.points, exit: way.exit, cost };
        }
        const exit = pick ? nav.exits[pick.exit] : undefined;
        const axis = localDirToWorld(b, ax * (pick?.sign ?? 1), ay * (pick?.sign ?? 1));
        const room = stallRoom(b, lx, ly, ax, ay, el.d / 2);
        if (!pick || !exit) {
          // No aisle from this stall leads out to a street: it is not used.
          out.push({ id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x, oy: axis.y, depth: el.d, lane: null, via: [], room, car: null });
          continue;
        }
        // Through a gate, the way runs on out of it to the footway's back.
        const local = [...pick.points, exit.inner, ...(exit.outer ? [exit.outer] : [])];
        const via = local.filter((q, i) => i === 0 || Math.hypot(q.x - local[i - 1]!.x, q.y - local[i - 1]!.y) > m(1))
          .map((q) => localToWorld(b, q.x, q.y));
        out.push({
          id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x, oy: axis.y,
          depth: el.d, lane: exit.lane, via, room, car: null,
        });
        continue;
      }
      const lane = laneFor(r, p.x, p.y);
      const axis = localDirToWorld(b, ax, ay);
      // Outside any lot: the stall opens towards the road it is reached from.
      const sign = lane && (lane.x - p.x) * axis.x + (lane.y - p.y) * axis.y < 0 ? -1 : 1;
      out.push({
        id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x * sign, oy: axis.y * sign,
        depth: el.d, lane, via: [], room: stallRoom(b, lx, ly, ax, ay, el.d / 2), car: null,
      });
    }
  }
  return out;
}

/** The walls whose bounds come within a few metres of a lot. */
function wallsNear(r: BayReads, b: LotRecord, v: { x: number; y: number; w: number; d: number }): readonly WallRing[] {
  const corners = [localToWorld(b, v.x, v.y), localToWorld(b, v.x + v.w, v.y), localToWorld(b, v.x + v.w, v.y + v.d), localToWorld(b, v.x, v.y + v.d)];
  const pad = m(3);
  const x0 = Math.min(...corners.map((c) => c.x)) - pad, x1 = Math.max(...corners.map((c) => c.x)) + pad;
  const y0 = Math.min(...corners.map((c) => c.y)) - pad, y1 = Math.max(...corners.map((c) => c.y)) + pad;
  return r.wallsIn(x0, y0, x1, y1);
}

/** A way out of a lot: a point inside its street edge, and the lane it joins, clear of every building. */
export interface LotExit {
  /** Local frame, a few metres inside the edge. */
  readonly inner: { readonly x: number; readonly y: number };
  /** Local frame, just inside the edge: the line from `inner` to it must be free of fences. */
  readonly edge: { readonly x: number; readonly y: number };
  readonly lane: BayLane;
  /** Distance from the edge to the lane's joining point. */
  readonly out: number;
  /** Local frame, just outside a gate: where a car is once through it. */
  readonly outer?: { readonly x: number; readonly y: number };
}

/** Where a car leaving through a gate joins its lane, past the gate; where one arriving stops, before it. */
const JOIN_PAST_GATE = m(6);
const STOP_BEFORE_GATE = m(5);
/** Kept clear of a lane's ends for a gate's stop and join points. */
const GATE_LANE_END = m(1.5);

/** A building's car gates: the `gate` elements a car fits through. */
export function carGates<E extends LotPart = BuildingElement>(b: { readonly elements?: readonly E[] }): E[] {
  return (b.elements ?? []).filter((el) => el.kind === 'gate' && el.w >= CAR_GATE);
}

/** The property of a lot closed by a boundary with car gates: the box of all its open blocks */
export function gatedProperty(b: Pick<LotRecord, 'volumes' | 'elements'>): { x: number; y: number; w: number; d: number } | null {
  if (!carGates(b).length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of b.volumes) {
    if (!v.open) continue;
    x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x + v.w); y1 = Math.max(y1, v.y + v.d);
  }
  if (!Number.isFinite(x0)) return null;
  // A little past the boundary, so the gate's own line lies inside the grid.
  const pad = m(1);
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, d: y1 - y0 + 2 * pad };
}

/** The ways out of a gated lot: one per car gate, its inner point a few metres inside, its outer point just outside */
export function gateExits(r: BayReads, b: LotRecord, property: { x: number; y: number; w: number; d: number }): LotExit[] {
  const out: LotExit[] = [];
  const cx = property.x + property.w / 2, cy = property.y + property.d / 2;
  for (const g of carGates(b)) {
    const alongY = g.facing === 1 || g.facing === 3;
    let ux = alongY ? 0 : 1, uy = alongY ? 1 : 0;
    if (g.angle) {
      const c = Math.cos(g.angle), s = Math.sin(g.angle);
      [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
    }
    // The gate's normal, into the lot.
    let nx = -uy, ny = ux;
    if ((cx - g.x) * nx + (cy - g.y) * ny < 0) { nx = -nx; ny = -ny; }
    const inner = { x: g.x + nx * EDGE_INSET, y: g.y + ny * EDGE_INSET };
    const edge = { x: g.x + nx * m(0.4), y: g.y + ny * m(0.4) };
    const outer = { x: g.x - nx * m(1.2), y: g.y - ny * m(1.2) };
    const wOuter = localToWorld(b, outer.x, outer.y);
    // A one-way street past the gate runs with the lot on its left as often as on its right.
    const lane = gateLane(r, wOuter.x, wOuter.y) ?? gateLane(r, wOuter.x, wOuter.y, true);
    if (!lane) continue;
    const reach = Math.hypot(lane.x - wOuter.x, lane.y - wOuter.y);
    if (reach > EDGE_REACH + JOIN_PAST_GATE) continue;
    if (!clearOfWalls(r, localToWorld(b, g.x, g.y), wOuter, m(1.1), b.id)) continue;
    out.push({ inner, edge, outer, lane, out: reach });
  }
  return out;
}

/** The lane in front of a gate, on the kerb side */
function gateLane(r: BayReads, x: number, y: number, eitherSide = false): BayLane | null {
  let best: BayLane | null = null;
  let bestD = LANE_REACH;
  for (const lane of r.lanesNear(x, y, LANE_REACH)) {
    if (lane.kind !== 'link' || lane.length < m(10)) continue;
    if (r.ghost(lane.id)) continue;
    const hit = lane.centre.closestPoint({ x, y });
    if (hit.distance >= bestD) continue;
    const foot = lane.centre.sampleAt(hit.s);
    // Right-hand traffic: the lot on the right of the direction of travel; on a one-way street, whichever kerb the lot is on
    if (!eitherSide && (x - foot.p.x) * foot.t.y - (y - foot.p.y) * foot.t.x <= 0) continue;
    if (eitherSide && r.bothWays(lane.segment!)) continue;
    const at = Math.max(GATE_LANE_END, Math.min(lane.length - GATE_LANE_END, hit.s + JOIN_PAST_GATE));
    const entryAt = Math.max(GATE_LANE_END, Math.min(lane.length - GATE_LANE_END, hit.s - STOP_BEFORE_GATE));
    // The gate must lie between where a car stops and where one joins.
    if (at - entryAt < m(3)) continue;
    const f = lane.centre.sampleAt(at);
    bestD = hit.distance;
    best = { lanelet: lane.id, at, x: f.p.x, y: f.p.y, tx: f.t.x, ty: f.t.y, entryAt };
  }
  return best;
}

/** Spacing of the points tried along a lot's sides. */
const EXIT_STEP = m(2);
/** Half the width of the swept path a car needs between the lot and its lane. */
const SWEEP = m(1.4);

/** Whether a car can be driven straight from `a` to `b` without its body touching a building. */
function clearOfWalls(r: Pick<BayReads, 'wallsIn'>, a: { x: number; y: number }, b: { x: number; y: number },
  sweep = SWEEP, except: BuildingId | null = null): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return true;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const near = r.wallsIn(Math.min(a.x, b.x) - sweep, Math.min(a.y, b.y) - sweep, Math.max(a.x, b.x) + sweep, Math.max(a.y, b.y) + sweep)
    .filter((wl) => wl.building !== except);
  if (near.length === 0) return true;
  const steps = Math.ceil(stepsIn(len, 0.8));
  for (let i = 0; i <= steps; i++) {
    const t = (len * i) / steps;
    for (const side of [-sweep, 0, sweep]) {
      const p = { x: a.x + ux * t - uy * side, y: a.y + uy * t + ux * side };
      if (near.some((wl) => p.x >= wl.x0 && p.x <= wl.x1 && p.y >= wl.y0 && p.y <= wl.y1 && pointInPolygon(p, wl.ring))) return false;
    }
  }
  return true;
}

/** The ways out of a lot onto a street */
function exitsOf(r: BayReads, b: LotRecord, v: { x: number; y: number; w: number; d: number }): LotExit[] {
  const sides = [
    { ax: v.x, ay: v.y, dx: 1, dy: 0, nx: 0, ny: -1, length: v.w },
    { ax: v.x + v.w, ay: v.y, dx: 0, dy: 1, nx: 1, ny: 0, length: v.d },
    { ax: v.x, ay: v.y + v.d, dx: 1, dy: 0, nx: 0, ny: 1, length: v.w },
    { ax: v.x, ay: v.y, dx: 0, dy: 1, nx: -1, ny: 0, length: v.d },
  ];
  // Only the lanes that could be near this lot are asked.
  const centre = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
  const reach = Math.hypot(v.w, v.d) / 2 + EDGE_REACH + m(10);
  const lanes = r.lanesNear(centre.x, centre.y, reach).filter((lane) => lane.centre.closestPoint(centre).distance < reach);
  const out: LotExit[] = [];
  for (const s of sides) {
    if (s.length < 2 * EDGE_MARGIN + m(1)) continue;
    for (let t = EDGE_MARGIN; t <= s.length - EDGE_MARGIN; t += EXIT_STEP) {
      const edge = localToWorld(b, s.ax + s.dx * t, s.ay + s.dy * t);
      const lane = laneFor(r, edge.x, edge.y, lanes);
      if (!lane) continue;
      const out1 = Math.hypot(lane.x - edge.x, lane.y - edge.y);
      if (out1 > EDGE_REACH) continue;
      const inner = { x: s.ax + s.dx * t - s.nx * EDGE_INSET, y: s.ay + s.dy * t - s.ny * EDGE_INSET };
      if (!clearOfWalls(r, localToWorld(b, inner.x, inner.y), lane)) continue;
      out.push({ inner, edge: { x: s.ax + s.dx * t - s.nx * m(0.2), y: s.ay + s.dy * t - s.ny * m(0.2) }, lane, out: out1 });
    }
  }
  return out;
}

/** The nearest drivable lane with room to join, its point beside `(x, y)`, on the kerb side. */
export function laneFor(r: BayReads, x: number, y: number, among?: Iterable<BayLaneLine>, segment?: SegmentId): BayLane | null {
  let best: BayLane | null = null;
  let bestD = LANE_REACH;
  const listed = among ? [...among] : null;
  const q = { x, y };
  // A lane farther than LANE_REACH is never taken: only those near are read.
  for (const lane of listed ?? r.lanesNear(x, y, LANE_REACH)) {
    if (lane.kind !== 'link' || lane.length < 2 * LANE_END + m(6)) continue;
    if (segment !== undefined && lane.segment !== segment) continue;
    if (r.ghost(lane.id)) continue;
    const hit = lane.centre.closestPoint(q);
    if (hit.distance >= bestD) continue;
    const at = Math.max(LANE_END, Math.min(lane.length - LANE_END, hit.s));
    const f = lane.centre.sampleAt(at);
    // Right-hand traffic: the kerb, and the lots beyond it, are on the right of the direction of travel.
    if ((q.x - f.p.x) * f.t.y - (q.y - f.p.y) * f.t.x <= 0) continue;
    bestD = hit.distance;
    best = { lanelet: lane.id, at, x: f.p.x, y: f.p.y, tx: f.t.x, ty: f.t.y };
  }
  return best;
}

// ------------------------------------------------------------ off the page

/** One lot to work out away from the page, as the page reads it: the record, the lanes and walls within its reach. */
export interface LotAsk {
  readonly building: LotRecord;
  /** The lanes within the lot's reach (`LaneGrid.near`), in id order, each with its flags now. */
  readonly lanes: readonly { readonly lane: Lanelet; readonly ghost: boolean; readonly bothWays: boolean }[];
  /** The walls within the lot's reach. */
  readonly walls: readonly WallRing[];
}

/** Numbers a part of a lot is sent as (`shareOf`): x, y, w, d, facing, z, angle, whether it has an angle. */
const PART = 8;

/** Lots to work out, as plain data for a worker (`postMessage` copies it, MDN "structured clone") */
export interface BayShare {
  readonly lanes: readonly {
    readonly id: LaneletId; readonly kind: Lanelet['kind']; readonly length: number; readonly segment?: SegmentId;
    readonly ghost: boolean; readonly bothWays: boolean; readonly xy: Float64Array;
  }[];
  readonly walls: readonly { readonly building: BuildingId; readonly ring: Float64Array; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  readonly kinds: readonly LotPart['kind'][];
  readonly lots: readonly {
    readonly id: BuildingId; readonly x: number; readonly y: number; readonly rotation: number;
    readonly volumes: readonly LotBlock[];
    /** Null: the record has no parts at all (`elements` absent). */
    readonly parts: Float64Array | null;
    readonly partKinds: Uint8Array | null;
    readonly lanes: Int32Array;
    readonly walls: Int32Array;
  }[];
}

/** Lots put as a share (`BayShare`), each lane and wall once. */
export function shareOf(asks: readonly LotAsk[]): BayShare {
  const laneAt = new Map<Lanelet, number>(), wallAt = new Map<WallRing, number>(), kindAt = new Map<LotPart['kind'], number>();
  const lanes: BayShare['lanes'][number][] = [];
  const walls: BayShare['walls'][number][] = [];
  const kinds: LotPart['kind'][] = [];
  const lots = asks.map((ask) => {
    const b = ask.building;
    let parts: Float64Array | null = null, partKinds: Uint8Array | null = null;
    if (b.elements) {
      parts = new Float64Array(b.elements.length * PART);
      partKinds = new Uint8Array(b.elements.length);
      b.elements.forEach((el, k) => {
        let kind = kindAt.get(el.kind);
        if (kind === undefined) { kindAt.set(el.kind, kind = kinds.length); kinds.push(el.kind); }
        partKinds![k] = kind;
        const o = k * PART;
        parts![o] = el.x; parts![o + 1] = el.y; parts![o + 2] = el.w; parts![o + 3] = el.d;
        parts![o + 4] = el.facing; parts![o + 5] = el.z; parts![o + 6] = el.angle ?? 0; parts![o + 7] = el.angle !== undefined ? 1 : 0;
      });
    }
    return {
      id: b.id, x: b.x, y: b.y, rotation: b.rotation,
      volumes: b.volumes.map((v) => ({ x: v.x, y: v.y, w: v.w, d: v.d, base: v.base, ...(v.open !== undefined ? { open: v.open } : {}) })),
      parts, partKinds,
      lanes: Int32Array.from(ask.lanes, ({ lane, ghost, bothWays }) => {
        let i = laneAt.get(lane);
        if (i === undefined) {
          laneAt.set(lane, i = lanes.length);
          lanes.push({ id: lane.id, kind: lane.kind, length: lane.length, ghost, bothWays, xy: lane.centre.xy, ...(lane.segment !== undefined ? { segment: lane.segment } : {}) });
        }
        return i;
      }),
      walls: Int32Array.from(ask.walls, (wall) => {
        let i = wallAt.get(wall);
        if (i === undefined) {
          wallAt.set(wall, i = walls.length);
          const ring = new Float64Array(wall.ring.length * 2);
          wall.ring.forEach((p, k) => { ring[2 * k] = p.x; ring[2 * k + 1] = p.y; });
          walls.push({ building: wall.building, ring, x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1 });
        }
        return i;
      }),
    };
  });
  return { lanes, walls, kinds, lots };
}

/** A lot's record from its share (`shareOf`): the parts as they were, an angle absent kept absent. */
function recordOf(share: BayShare, lot: BayShare['lots'][number]): LotRecord {
  const { parts, partKinds } = lot;
  const record = { id: lot.id, x: lot.x, y: lot.y, rotation: lot.rotation, volumes: lot.volumes };
  if (!parts || !partKinds) return record;
  const elements: LotPart[] = [];
  for (let k = 0; k < partKinds.length; k++) {
    const o = k * PART;
    elements.push({
      kind: share.kinds[partKinds[k]!]!, x: parts[o]!, y: parts[o + 1]!, w: parts[o + 2]!, d: parts[o + 3]!,
      facing: parts[o + 4]! as LotPart['facing'], z: parts[o + 5]!, ...(parts[o + 7] ? { angle: parts[o + 6]! } : {}),
    });
  }
  return { ...record, elements };
}

/** Every lot of a share worked out (`bayRows`) on what was sent, in order: each lane's line made once */
export function baysOfShare(share: BayShare, progress?: () => void): Bay[][] {
  const lanes = share.lanes.map((l) => {
    const line: BayLaneLine & { ghost: boolean; bothWays: boolean } = {
      id: l.id, kind: l.kind, length: l.length, centre: Polyline.fromFlat(l.xy), ghost: l.ghost, bothWays: l.bothWays,
      ...(l.segment !== undefined ? { segment: l.segment } : {}),
    };
    return line;
  });
  const walls: WallRing[] = share.walls.map((wl) => {
    const ring: { x: number; y: number }[] = [];
    for (let k = 0; k < wl.ring.length; k += 2) ring.push({ x: wl.ring[k]!, y: wl.ring[k + 1]! });
    return { building: wl.building, ring, x0: wl.x0, y0: wl.y0, x1: wl.x1, y1: wl.y1 };
  });
  const segmentsBothWays = new Map<SegmentId, boolean>();
  for (const l of lanes) if (l.segment !== undefined) segmentsBothWays.set(l.segment, l.bothWays);
  const ghosts = new Map(lanes.map((l) => [l.id, l.ghost]));
  return share.lots.map((lot) => {
    const own = Array.from(lot.lanes, (i) => lanes[i]!);
    const ownWalls = Array.from(lot.walls, (i) => walls[i]!);
    const reads: BayReads = {
      lanesNear: (x, y, reach) => !Number.isFinite(x) || !Number.isFinite(y) ? own
        : own.filter((l) => cellsMeet(l.centre.bbox, x - reach, y - reach, x + reach, y + reach)),
      ghost: (id) => ghosts.get(id) ?? false,
      bothWays: (segment) => segmentsBothWays.get(segment) ?? false,
      wallsIn: (x0, y0, x1, y1) => ownWalls.filter((wl) => wl.x1 >= x0 && wl.x0 <= x1 && wl.y1 >= y0 && wl.y0 <= y1),
    };
    const bays = bayRows(reads, recordOf(share, lot));
    progress?.();
    return bays;
  });
}
