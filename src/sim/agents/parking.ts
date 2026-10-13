import { pointInPolygon } from '@core/polygon';
import { localDirToWorld, storedBounds, localToWorld, solidFootprints, worldToLocal } from '@world/buildings/geometry';
import { Digest } from '@core/digest';
import { type LotGrid, buildLotGrid, wayOut } from './lotNav';
import type { Building, BuildingElement, BuildingId } from '@world/buildings/types';
import type { Lanelet, LaneletId } from '@world/lanelets';
import { m, stepsIn } from '@world/units';
import type { ChangeRect } from '@world/changes';
import type { SimWorld } from '../world';
import type { VehicleId } from '../vehicles/state';
import type { SegmentId } from '@world/ids';
import { parkingLayout } from '@world/parkingLayout';
import { PARKING_PITCH } from '@world/parking';

/**
 * The parking bays of the city: where a resident's car stands when it is not
 * on the road.
 *
 * A car used to be made at the kerb when its driver set off and deleted when
 * it arrived, the "pocket car" of Cities: Skylines 1. Cities: Skylines II
 * parks every car in a real space and lets the lack of one change how a
 * citizen travels (Development Diary #11); so does this. Every bay painted on
 * a lot (`parking` elements, `editor/lotPlan.ts`, `world/defaultTown.ts`) is
 * a space for one car, with the side it opens on and the point of the road a
 * car leaves it for and comes back from.
 */

/** Width of one stall, as the lot planner lays them (2.5 x 5 m). */
const STALL = m(2.5);
/** A stall wider than this is a lorry's dock, not a car's bay. */
const LORRY_DOCK = m(3.2);
/** Farthest a bay may be from the lane it is reached from. */
const LANE_REACH = m(45);
/** Kept clear of the ends of a lane where a car joins or leaves it. */
const LANE_END = m(20);

export interface BayLane {
  readonly lanelet: LaneletId;
  /** Arc position of the point where a car's body centre joins or leaves the lane. */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** Unit direction of travel there. */
  readonly tx: number;
  readonly ty: number;
  /**
   * For a lot entered by a car gate: the arc position (body centre) an
   * arriving car stops at, a few metres BEFORE the gate, to turn in through
   * it; `at` is then a few metres past the gate, where a car leaving joins.
   * As SUMO binds a parking area to the lane its access is on, the gate's
   * lane is the one a lot is driven to and left by.
   */
  readonly entryAt?: number;
}

export interface Bay {
  readonly id: number;
  readonly building: BuildingId;
  /** Centre of the stall. */
  readonly x: number;
  readonly y: number;
  /** Unit direction out of the stall, towards its open end. */
  readonly ox: number;
  readonly oy: number;
  /** Depth of the stall. */
  readonly depth: number;
  /** The road it is reached from; null when no lane is near enough. */
  readonly lane: BayLane | null;
  /**
   * The way through its lot, from the aisle in front of the stall to the lot's
   * street edge (world points, in the order a car leaving drives them): a car
   * keeps to the lot and never cuts across a building to the nearest road.
   * Empty for a bay outside any lot: it is driven straight to its lane.
   */
  readonly via: readonly { readonly x: number; readonly y: number }[];
  /**
   * Half the stall's clear length: from its centre to its nearer end, or to
   * the first part of the lot or wall standing in the stall before that
   * (`stallRoom`). A body is parked centred, so it fits when half its
   * length is no more than this (`stallFits`).
   */
  readonly room: number;
  /** The car standing in it, or coming to it (reserved). */
  car: VehicleId | null;
  /**
   * A bay along a street's kerb (`world/parkingLayout.ts`), not in a lot: a
   * car backs into it from the lane beside, as one parks on a real street,
   * and drives forward out of it. Its lane point is a few metres ahead of it.
   */
  readonly kerb?: true;
}

/**
 * Whether a body this long stands wholly inside the stall, parked centred in
 * it. Parking codes keep a parked vehicle inside its stall and the stall clear
 * of obstructions (Calgary Land Use Bylaw 1P2007 s.122: "stall dimensions must
 * be clear of all obstructions"; Kannapolis 408: "no part of any parked
 * vehicle will extend beyond the boundaries of the parking space"). A van of
 * 5.6 m was parked centred in a stall of 5 m whose back the lot's fence takes
 * 5 cm of, and its nose stood 35 cm through the fence; cars stood through the
 * planters and a lamp standing in the ends of stalls. A stall now takes only
 * what fits it.
 */
export function stallFits(bay: Pick<Bay, 'room'>, length: number): boolean {
  return length / 2 <= bay.room + FIT_EPS;
}
/** A body touching the stall's end is in it. */
const FIT_EPS = m(0.001);

/**
 * Every part of a lot that a parked body may not stand in: what a car cannot
 * drive through (`lotNav.ts` SOLID, less the stalls themselves) - the
 * boundary, posts, lamps, bins, planters, trees, steps.
 */
const STALL_BLOCKS: ReadonlySet<string> = new Set([
  'wall', 'fence', 'hedge', 'railing', 'gate', 'pillar', 'stair', 'ramp', 'tree', 'bench', 'planter', 'rocks',
  'clock', 'shrub', 'bin', 'lamp', 'bollard',
]);
/** Parts this high off the ground or more stand over a parked body (a canopy, a sign). */
const OVER_A_BODY = m(2.1);
/** Half the widest body that parks in a stall (a van, 2 m) and a hand: the band a stall's clear length is read in. */
const STALL_BAND = m(1.05);

/**
 * Half the clear length of a stall (local frame of its building): from its
 * centre `(lx, ly)` along `(dx, dy)` (unit, along the stall) and against it, to
 * the first part of the lot or solid volume a body there would touch, in the
 * band a body's width wide; at most `half` (half the stall's depth). A part
 * standing over the centre leaves no room at all.
 */
function stallRoom(b: Building, lx: number, ly: number, dx: number, dy: number, half: number): number {
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
    if (!STALL_BLOCKS.has(el.kind) || el.z >= OVER_A_BODY) continue;
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

/**
 * A convex ring cut to one side of a line of the stall's frame
 * (Sutherland-Hodgman): `axis` 0 keeps u >= `at`; 1 keeps v >= `at`; -1 keeps
 * -v >= `at` (v <= -`at`).
 */
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

/** Every stall of every parking element, with the way out of its lot and the lane it is reached from. */
/**
 * The bays as last worked out, by world: the ambient traffic and the
 * residents' cars both asked for them on every edit, and each worked out every
 * lot, exit and aisle of the town again (docs/performance.md #15). Handed out
 * as fresh copies (a holder sets `car` on its own).
 */
const BAYS = new WeakMap<SimWorld, { key: string; first: unknown; bays: readonly Bay[] }>();
export function collectBays(w: SimWorld): Bay[] {
  const roads = roadsKey(w);
  const key = `${w.doc.buildings.revision}:${roads}`;
  const first = w.graph.lanelets.values().next().value;
  let known = BAYS.get(w);
  if (!known || known.key !== key || known.first !== first) BAYS.set(w, known = { key, first, bays: workOutBays(w, roads, first) });
  return known.bays.map((bay) => ({ ...bay, car: null }));
}
/** What the bays read of the roads: the traffic's topology and the lanes. */
const roadsKey = (w: SimWorld): string => `${w.topologyRevision}:${w.graph.revision}:${w.graph.lanelets.size}`;

/** Cell of the lanes' grid, world units. */
const LANE_CELL = m(30);
const LANE_GRIDS = new WeakMap<object, { key: string; lanes: Lanelet[]; cells: Map<number, number[]> }>();
/**
 * The lanes whose bounds come within `reach` of a point, in the graph's order
 * (the tie-break), from a grid of their bounds: every bay and every lot used to
 * measure every lane of the town.
 */
function lanesNear(w: SimWorld, x: number, y: number, reach: number): Lanelet[] {
  const key = `${w.graph.revision}:${w.graph.lanelets.size}`;
  let grid = LANE_GRIDS.get(w.graph);
  // Rebuilt under the same revision, the lanes are new objects: read again.
  if (!grid || grid.key !== key || (grid.lanes.length > 0 && grid.lanes[0] !== w.graph.lanelets.values().next().value)) {
    const lanes = [...w.graph.lanelets.values()];
    const cells = new Map<number, number[]>();
    lanes.forEach((lane, i) => {
      const box = lane.centre.bbox;
      for (let gx = Math.floor(box.minX / LANE_CELL); gx <= Math.floor(box.maxX / LANE_CELL); gx++) {
        for (let gy = Math.floor(box.minY / LANE_CELL); gy <= Math.floor(box.maxY / LANE_CELL); gy++) {
          const k = (gx + 32768) * 65536 + (gy + 32768);
          const list = cells.get(k);
          if (list) list.push(i); else cells.set(k, [i]);
        }
      }
    });
    LANE_GRIDS.set(w.graph, grid = { key, lanes, cells });
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return grid.lanes;
  const picked = new Set<number>();
  for (let gx = Math.floor((x - reach) / LANE_CELL); gx <= Math.floor((x + reach) / LANE_CELL); gx++) {
    for (let gy = Math.floor((y - reach) / LANE_CELL); gy <= Math.floor((y + reach) / LANE_CELL); gy++) {
      for (const i of grid.cells.get((gx + 32768) * 65536 + (gy + 32768)) ?? []) picked.add(i);
    }
  }
  return [...picked].sort((a, b) => a - b).map((i) => grid.lanes[i]!);
}

/**
 * Each building's bays as last worked out, with what they were worked out
 * from: its record, the lanes within reach (their lines and whether they are
 * ghosts) and the walls within reach. A road edit worked out the exits and
 * aisles of every lot in town again; a lot whose surroundings are the same
 * keeps its bays (docs/performance.md #15).
 */
const LOT_BAYS = new WeakMap<SimWorld, Map<BuildingId, { lot: string; key: number; bays: readonly Bay[] }>>();
/** How far a lot's bays read lanes and walls (`LANE_REACH`, the exits' reach), with a margin. */
const LOT_READS = LANE_REACH + m(12);
/**
 * What a building's bays are worked out from, as text, once per record: the
 * record less its age, its name and its lot plan's version. A record is
 * replaced on any change, and the town's ageing (a record every few seconds)
 * worked out those lots' exits, grids and aisles again for nothing.
 */
const LOT_TEXT = new WeakMap<Building, string>();
function lotText(b: Building): string {
  let text = LOT_TEXT.get(b);
  if (text === undefined) {
    const { decay: _decay, builtAt: _builtAt, name: _name, lotPlan: _lotPlan, ...lot } = b;
    text = JSON.stringify(lot);
    LOT_TEXT.set(b, text);
  }
  return text;
}

/**
 * Where the bays were last worked out from: the roads (`roadsKey`, the first
 * lane object) and the diary's serial. With the roads the same, only the lots
 * whose reach a building change since then touched can see anything new.
 */
const LAST_PASS = new WeakMap<SimWorld, { roads: string; first: unknown; serial: number }>();
/**
 * The building changes since the last pass, as rectangles, when the roads are
 * the same; null when the lots must be digested again (the roads changed, or
 * the diary forgot, or a change covered the whole map).
 */
function buildingChangesSince(w: SimWorld, roads: string, first: unknown): ChangeRect[] | null {
  const last = LAST_PASS.get(w);
  LAST_PASS.set(w, { roads, first, serial: w.doc.changes.version });
  if (!last || last.roads !== roads || last.first !== first) return null;
  const entries = w.doc.changes.since(last.serial, ['buildings']);
  if (!entries) return null;
  const rects: ChangeRect[] = [];
  for (const entry of entries) {
    if (!entry.rects) return null;
    rects.push(...entry.rects);
  }
  return rects;
}

function workOutBays(w: SimWorld, roads: string, first: unknown): Bay[] {
  const out: Bay[] = [];
  // A building grown in a town of a thousand: every parking lot's lanes and
  // walls digested again, 60 ms a building (audit M3a). With the roads as
  // they were, a lot whose reach no building change touched keeps its bays
  // without reading anything (the diary's rectangles: `world/changes.ts`).
  const changed = buildingChangesSince(w, roads, first);
  let walls: Wall[] | null = null;
  const wallsNow = (): Wall[] => (walls ??= wallsOf(w));
  const navCache = new Map<object, { exits: LotExit[]; grid: LotGrid }>();
  const known = LOT_BAYS.get(w) ?? new Map<BuildingId, { lot: string; key: number; bays: readonly Bay[] }>();
  const kept = new Map<BuildingId, { lot: string; key: number; bays: readonly Bay[] }>();
  LOT_BAYS.set(w, kept);
  for (const b of w.doc.buildings.all()) {
    if (!(b.elements ?? []).some((el) => el.kind === 'parking')) continue;
    const box = storedBounds(b, LOT_READS);
    const was = known.get(b.id);
    const lot = lotText(b);
    if (changed && was && was.lot === lot
      && !changed.some((r) => r[0] <= box.maxX && r[2] >= box.minX && r[1] <= box.maxY && r[3] >= box.minY)) {
      for (const bay of was.bays) out.push({ ...bay, id: out.length });
      kept.set(b.id, was);
      continue;
    }
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    const digest = new Digest();
    for (const lane of lanesNear(w, cx, cy, Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2)) {
      digest.addText(lane.id).add(lane.length).add(w.rt(lane.id).ghost ? 1 : 0).addAll(lane.centre.xy);
    }
    for (const wall of wallsInBox(wallsNow(), box.minX, box.minY, box.maxX, box.maxY)) {
      digest.add(wall.building);
      for (const q of wall.ring) digest.add(q.x).add(q.y);
    }
    const key = digest.value();
    if (was && was.lot === lot && was.key === key) {
      for (const bay of was.bays) out.push({ ...bay, id: out.length });
      kept.set(b.id, was);
      continue;
    }
    const first = out.length;
    bayRows(b);
    kept.set(b.id, { lot, key, bays: out.slice(first) });
  }
  out.push(...kerbBays(w, out.length));
  return out;

  function bayRows(b: Building): void {
    // A lot closed by a boundary with car gates (`editor/lotPlan.ts`): the
    // whole property is driven, and its only ways out are its car gates.
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
        const exits = property ? gateExits(w, b, property, wallsNow()) : exitsOf(w, b, lot, wallsNow());
        const local = wallsNear(wallsNow(), b, lot).map((wl) => wl.ring.map((q) => worldToLocal(b, q)));
        nav = { exits, grid: buildLotGrid(b, lot, local, exits) };
        navCache.set(lot, nav);
      }
      for (let k = 0; k < stalls; k++) {
        const u = -el.w / 2 + (el.w * (k + 0.5)) / stalls;
        const lx = el.x + cx * u, ly = el.y + cy * u;
        const p = localToWorld(b, lx, ly);
        if (lot && nav) {
          // The stall opens on whichever side has an aisle that leads out of
          // the lot, down the aisles to the nearest way out onto a street.
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
        const lane = laneFor(w, p.x, p.y);
        const axis = localDirToWorld(b, ax, ay);
        // Outside any lot: the stall opens towards the road it is reached from.
        const sign = lane && (lane.x - p.x) * axis.x + (lane.y - p.y) * axis.y < 0 ? -1 : 1;
        out.push({
          id: out.length, building: b.id, x: p.x, y: p.y, ox: axis.x * sign, oy: axis.y * sign,
          depth: el.d, lane, via: [], room: stallRoom(b, lx, ly, ax, ay, el.d / 2), car: null,
        });
      }
    }
  }
}

/** Ahead of a kerb bay, the place on the lane a car stops at to back in, and leaves for. */
const KERB_AHEAD = m(7);
/** The least a kerb bay's joining point may lie ahead of it, u. */
const KERB_MIN_AHEAD = m(4);
/** No lot: the bay stands on the street. */
const NO_LOT = -1 as BuildingId;

/** Every bay along the kerbs of the streets that park (`RoadSegment.parking`). */
function kerbBays(w: SimWorld, first: number): Bay[] {
  const out: Bay[] = [];
  for (const bay of parkingLayout(w.net).bays) {
    const f = bay.facing;
    const ahead = { x: bay.centre.x + f.x * KERB_AHEAD, y: bay.centre.y + f.y * KERB_AHEAD };
    const lane = laneFor(w, ahead.x, ahead.y, undefined, bay.segment);
    // The lane has to run the way the car faces: the traffic beside the bay;
    // and its joining point (kept `LANE_END` clear of the junctions) must lie
    // ahead of the bay. Near the end of a street it falls behind it, and the
    // car would turn round on the spot, its tail sweeping the footway.
    const aligned = lane !== null && lane.tx * f.x + lane.ty * f.y > 0.7
      && (lane.x - bay.centre.x) * f.x + (lane.y - bay.centre.y) * f.y >= KERB_MIN_AHEAD;
    out.push({
      id: first + out.length, building: NO_LOT, x: bay.centre.x, y: bay.centre.y,
      // The car stands nose along the kerb: `o` points out of its tail.
      ox: -f.x, oy: -f.y, depth: PARKING_PITCH.parallel,
      lane: aligned ? lane : null, via: [], room: PARKING_PITCH.parallel / 2, car: null, kerb: true,
    });
  }
  return out;
}

/** The walls whose bounds come within a few metres of a lot, in list order. */
function wallsNear(walls: readonly Wall[], b: Building, v: { x: number; y: number; w: number; d: number }): Wall[] {
  const corners = [localToWorld(b, v.x, v.y), localToWorld(b, v.x + v.w, v.y), localToWorld(b, v.x + v.w, v.y + v.d), localToWorld(b, v.x, v.y + v.d)];
  const pad = m(3);
  const x0 = Math.min(...corners.map((c) => c.x)) - pad, x1 = Math.max(...corners.map((c) => c.x)) + pad;
  const y0 = Math.min(...corners.map((c) => c.y)) - pad, y1 = Math.max(...corners.map((c) => c.y)) + pad;
  const hits = new Set(wallsInBox(walls, x0, y0, x1, y1));
  return walls.filter((wl) => hits.has(wl));
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

/** The narrowest gate a car is driven through (a person's gate is 1.2 m). */
const CAR_GATE = m(2.2);
/** Where a car leaving through a gate joins its lane, past the gate; where one arriving stops, before it. */
const JOIN_PAST_GATE = m(6);
const STOP_BEFORE_GATE = m(5);
/**
 * Kept clear of a lane's ends for a gate's stop and join points. Small: a
 * gate beside a block's corner opens onto the very end of its street's lane
 * (a town's streets are a few tens of metres between junctions), and a lane
 * end kept six metres clear left one car park in five with no way out.
 */
const GATE_LANE_END = m(1.5);

/** A building's car gates: the `gate` elements a car fits through. */
export function carGates(b: Building): BuildingElement[] {
  return (b.elements ?? []).filter((el) => el.kind === 'gate' && el.w >= CAR_GATE);
}

/**
 * The property of a lot closed by a boundary with car gates: the box of all
 * its open blocks (front, drive, yard, car park), in the local frame. Null
 * for a lot with no car gate, whose stalls are reached as before.
 */
export function gatedProperty(b: Building): { x: number; y: number; w: number; d: number } | null {
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

/**
 * The ways out of a gated lot: one per car gate, its inner point a few metres
 * inside, its outer point just outside, and the lane of the street in front
 * of it - joined a few metres past the gate and stopped at a few metres
 * before it, so a car crosses the footway square to the kerb and turns on
 * the carriageway (`manoeuvre.ts`).
 */
export function gateExits(w: SimWorld, b: Building, property: { x: number; y: number; w: number; d: number }, walls: readonly Wall[]): LotExit[] {
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
    const lane = gateLane(w, wOuter.x, wOuter.y) ?? gateLane(w, wOuter.x, wOuter.y, true);
    if (!lane) continue;
    const reach = Math.hypot(lane.x - wOuter.x, lane.y - wOuter.y);
    if (reach > EDGE_REACH + JOIN_PAST_GATE) continue;
    if (!clearOfWalls(walls, localToWorld(b, g.x, g.y), wOuter, m(1.1), b.id)) continue;
    out.push({ inner, edge, outer, lane, out: reach });
  }
  return out;
}

/**
 * The lane in front of a gate, on the kerb side: its join point `JOIN_PAST_GATE`
 * along the travel from the gate's foot, its stop point `STOP_BEFORE_GATE`
 * before it, both kept `GATE_LANE_END` clear of the lane's ends.
 */
function gateLane(w: SimWorld, x: number, y: number, eitherSide = false): BayLane | null {
  let best: BayLane | null = null;
  let bestD = LANE_REACH;
  for (const lane of lanesNear(w, x, y, LANE_REACH)) {
    if (lane.kind !== 'link' || lane.length < m(10)) continue;
    if (w.rt(lane.id).ghost) continue;
    const hit = lane.centre.closestPoint({ x, y });
    if (hit.distance >= bestD) continue;
    const foot = lane.centre.sampleAt(hit.s);
    // Right-hand traffic: the lot on the right of the direction of travel;
    // on a one-way street, whichever kerb the lot is on (`gateExits`).
    if (!eitherSide && (x - foot.p.x) * foot.t.y - (y - foot.p.y) * foot.t.x <= 0) continue;
    if (eitherSide && w.doc.segment(lane.segment!)?.direction === 'both') continue;
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

export interface Wall {
  readonly building: BuildingId;
  readonly ring: readonly { x: number; y: number }[];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
}

/** Every building's solid footprint, with its bounds. */
export function wallsOf(w: SimWorld): Wall[] {
  const out: Wall[] = [];
  for (const b of w.doc.buildings.all()) {
    for (const ring of solidFootprints(b)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      out.push({ building: b.id, ring, x0, y0, x1, y1 });
    }
  }
  return out;
}

/** Cell of the walls' grid, world units. */
const WALL_CELL = m(30);
const WALL_GRIDS = new WeakMap<readonly Wall[], Map<number, Wall[]>>();
/**
 * The walls whose bounds meet a box, read from a grid of them: every exit
 * tried from every lot filtered every building in town.
 */
function wallsInBox(walls: readonly Wall[], x0: number, y0: number, x1: number, y1: number): Wall[] {
  let cells = WALL_GRIDS.get(walls);
  if (!cells) {
    cells = new Map();
    for (const wl of walls) {
      for (let gx = Math.floor(wl.x0 / WALL_CELL); gx <= Math.floor(wl.x1 / WALL_CELL); gx++) {
        for (let gy = Math.floor(wl.y0 / WALL_CELL); gy <= Math.floor(wl.y1 / WALL_CELL); gy++) {
          const k = gx * 65536 + gy;
          const list = cells.get(k);
          if (list) list.push(wl); else cells.set(k, [wl]);
        }
      }
    }
    WALL_GRIDS.set(walls, cells);
  }
  const seen = new Set<Wall>();
  const out: Wall[] = [];
  for (let gx = Math.floor(x0 / WALL_CELL); gx <= Math.floor(x1 / WALL_CELL); gx++) {
    for (let gy = Math.floor(y0 / WALL_CELL); gy <= Math.floor(y1 / WALL_CELL); gy++) {
      for (const wl of cells.get(gx * 65536 + gy) ?? []) {
        if (seen.has(wl)) continue;
        seen.add(wl);
        if (wl.x1 >= x0 && wl.x0 <= x1 && wl.y1 >= y0 && wl.y0 <= y1) out.push(wl);
      }
    }
  }
  return out;
}

/** Whether a car can be driven straight from `a` to `b` without its body touching a building. */
export function clearOfWalls(walls: readonly Wall[], a: { x: number; y: number }, b: { x: number; y: number },
  sweep = SWEEP, except: BuildingId | null = null): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return true;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const near = wallsInBox(walls, Math.min(a.x, b.x) - sweep, Math.min(a.y, b.y) - sweep, Math.max(a.x, b.x) + sweep, Math.max(a.y, b.y) + sweep)
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

/**
 * The ways out of a lot onto a street: points along its sides from which a car
 * reaches a lane on the lot's kerb side in a straight line without crossing a
 * building. In a town of perimeter blocks, a car park in the middle of a block
 * is left by the passage between the buildings, not through them.
 */
function exitsOf(w: SimWorld, b: Building, v: { x: number; y: number; w: number; d: number }, walls: readonly Wall[]): LotExit[] {
  const sides = [
    { ax: v.x, ay: v.y, dx: 1, dy: 0, nx: 0, ny: -1, length: v.w },
    { ax: v.x + v.w, ay: v.y, dx: 0, dy: 1, nx: 1, ny: 0, length: v.d },
    { ax: v.x, ay: v.y + v.d, dx: 1, dy: 0, nx: 0, ny: 1, length: v.w },
    { ax: v.x, ay: v.y, dx: 0, dy: 1, nx: -1, ny: 0, length: v.d },
  ];
  // Only the lanes that could be near this lot are asked.
  const centre = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
  const reach = Math.hypot(v.w, v.d) / 2 + EDGE_REACH + m(10);
  const lanes = lanesNear(w, centre.x, centre.y, reach).filter((lane) => lane.centre.closestPoint(centre).distance < reach);
  const out: LotExit[] = [];
  for (const s of sides) {
    if (s.length < 2 * EDGE_MARGIN + m(1)) continue;
    for (let t = EDGE_MARGIN; t <= s.length - EDGE_MARGIN; t += EXIT_STEP) {
      const edge = localToWorld(b, s.ax + s.dx * t, s.ay + s.dy * t);
      const lane = laneFor(w, edge.x, edge.y, lanes);
      if (!lane) continue;
      const out1 = Math.hypot(lane.x - edge.x, lane.y - edge.y);
      if (out1 > EDGE_REACH) continue;
      const inner = { x: s.ax + s.dx * t - s.nx * EDGE_INSET, y: s.ay + s.dy * t - s.ny * EDGE_INSET };
      if (!clearOfWalls(walls, localToWorld(b, inner.x, inner.y), lane)) continue;
      out.push({ inner, edge: { x: s.ax + s.dx * t - s.nx * m(0.2), y: s.ay + s.dy * t - s.ny * m(0.2) }, lane, out: out1 });
    }
  }
  return out;
}

/** The lane beside a point of a street (a bus stop): the nearest on the kerb side of that road, its point there. */
export function laneBeside(w: SimWorld, x: number, y: number, segment?: SegmentId): BayLane | null {
  return laneFor(w, x, y, undefined, segment);
}

/** The nearest drivable lane with room to join, its point beside `(x, y)`, on the kerb side. */
function laneFor(w: SimWorld, x: number, y: number, among?: Iterable<Lanelet>, segment?: SegmentId): BayLane | null {
  let best: BayLane | null = null;
  let bestD = LANE_REACH;
  const listed = among ? [...among] : null;
  const q = { x, y };
  // A lane farther than LANE_REACH is never taken: only those near are read.
  for (const lane of listed ?? lanesNear(w, x, y, LANE_REACH)) {
    if (lane.kind !== 'link' || lane.length < 2 * LANE_END + m(6)) continue;
    if (segment !== undefined && lane.segment !== segment) continue;
    if (w.rt(lane.id).ghost) continue;
    const hit = lane.centre.closestPoint(q);
    if (hit.distance >= bestD) continue;
    const at = Math.max(LANE_END, Math.min(lane.length - LANE_END, hit.s));
    const f = lane.centre.sampleAt(at);
    // Right-hand traffic: the kerb, and the lots beyond it, are on the right of
    // the direction of travel. A lane with the bay on its left is the far one.
    if ((q.x - f.p.x) * f.t.y - (q.y - f.p.y) * f.t.x <= 0) continue;
    bestD = hit.distance;
    best = { lanelet: lane.id, at, x: f.p.x, y: f.p.y, tx: f.t.x, ty: f.t.y };
  }
  return best;
}

