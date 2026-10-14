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
import type { BuildingStore } from '@world/buildings/store';
import { BuildingsInOrder } from './buildingOrder';
import { CAR_GATE, type KerbBook, followKerbs, newKerbBook } from './kerbBays';

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

/**
 * Every stall of every parking element, with the way out of its lot and the
 * lane it is reached from, then every bay along the kerbs: handed out as
 * fresh copies (a holder sets `car` on its own).
 *
 * Kept from the diary (`baysNow`): a building changed works out again only
 * the lots within its reach and the streets whose kerbs its gates face. The
 * town's ageing replaces a record every few seconds, and each time every
 * lot, wall and lot entrance of the town was read again (audit M3a).
 */
export function collectBays(w: SimWorld): Bay[] {
  return baysNow(w).map((bay) => ({ ...bay, car: null }));
}
/** What the bays read of the roads: the traffic's topology and the lanes. */
const roadsKey = (w: SimWorld): string => `${w.topologyRevision}:${w.graph.revision}:${w.graph.lanelets.size}`;

/** Cell of the lanes' grid, world units. */
const LANE_CELL = m(30);
/**
 * The lanes of the graph by place, each lane's digest (`laneDigest`), NaN
 * until a lot asks for it, and each lane's place in the graph's order
 * (`laneRank`), made when first asked.
 */
interface LaneGrid { key: string; lanes: Lanelet[]; cells: Map<number, number[]>; digests: Float64Array; rank?: Map<LaneletId, number> }
const LANE_GRIDS = new WeakMap<object, LaneGrid>();
/**
 * The lanes whose bounds come within `reach` of a point, in the graph's order
 * (the tie-break), from a grid of their bounds: every bay and every lot used to
 * measure every lane of the town.
 */
function lanesNear(w: SimWorld, x: number, y: number, reach: number): Lanelet[] {
  const grid = laneGrid(w);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return grid.lanes;
  return laneIndicesNear(grid, x, y, reach).map((i) => grid.lanes[i]!);
}

/** `lanesNear`, as the lanes' places in the grid's list (all of them for a point that is not one). */
function laneIndicesNear(grid: LaneGrid, x: number, y: number, reach: number): number[] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return grid.lanes.map((_, i) => i);
  const picked = new Set<number>();
  for (let gx = Math.floor((x - reach) / LANE_CELL); gx <= Math.floor((x + reach) / LANE_CELL); gx++) {
    for (let gy = Math.floor((y - reach) / LANE_CELL); gy <= Math.floor((y + reach) / LANE_CELL); gy++) {
      for (const i of grid.cells.get((gx + 32768) * 65536 + (gy + 32768)) ?? []) picked.add(i);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * A lane's part of a lot's key (`lotBaysOf`): its id, its length and its
 * centre line, digested once per lane of the grid. A lane is never changed
 * in place (`Lanelet` is read-only, its `Polyline` immutable) and the grid
 * is made again with the lanes: a rebuilt lane is digested again, to the
 * same number when it is the same lane, so a lot whose lanes were only
 * rebuilt keeps its bays.
 */
function laneDigest(grid: LaneGrid, i: number): number {
  let value = grid.digests[i]!;
  if (Number.isNaN(value)) {
    const lane = grid.lanes[i]!;
    value = new Digest().addText(lane.id).add(lane.length).addAll(lane.centre.xy).value();
    grid.digests[i] = value;
  }
  return value;
}

/** The lanes' grid (`lanesNear`). @rebuild Called when the lane graph moved; otherwise returns the grid it made. */
function laneGrid(w: SimWorld): LaneGrid {
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
    LANE_GRIDS.set(w.graph, grid = { key, lanes, cells, digests: new Float64Array(lanes.length).fill(NaN) });
  }
  return grid;
}

/** Each lane's place in the graph's order (`lanesInBox`'s order), to sort what was found by it. */
export function laneRank(w: SimWorld): (id: LaneletId) => number {
  const grid = laneGrid(w);
  const rank = grid.rank ??= new Map(grid.lanes.map((lane, i) => [lane.id, i]));
  return (id) => rank.get(id) ?? Infinity;
}

/**
 * The lanes whose bounds meet a box, in the graph's order, from the lanes'
 * grid: what a loop over every lane with the same bounds test keeps, in the
 * order it keeps them.
 */
export function lanesInBox(w: SimWorld, x0: number, y0: number, x1: number, y1: number): Lanelet[] {
  const grid = laneGrid(w);
  const picked = new Set<number>();
  for (let gx = Math.floor(x0 / LANE_CELL); gx <= Math.floor(x1 / LANE_CELL); gx++) {
    for (let gy = Math.floor(y0 / LANE_CELL); gy <= Math.floor(y1 / LANE_CELL); gy++) {
      for (const i of grid.cells.get((gx + 32768) * 65536 + (gy + 32768)) ?? []) picked.add(i);
    }
  }
  const out: Lanelet[] = [];
  for (const i of [...picked].sort((a, b) => a - b)) {
    const lane = grid.lanes[i]!, box = lane.centre.bbox;
    if (box.maxX < x0 || box.minX > x1 || box.maxY < y0 || box.minY > y1) continue;
    out.push(lane);
  }
  return out;
}

/** How far a lot's bays read lanes and walls (`LANE_REACH`, the exits' reach), with a margin. */
const LOT_READS = LANE_REACH + m(12);
/**
 * How far round a change a lot's box grown by `LOT_READS` may reach: a
 * volume or an element grown by `g` in its own frame moves its corners by up
 * to `g` times root two in the world's.
 */
const LOT_REACHED = LOT_READS * 2;
/**
 * What a building's bays are worked out from, as text, once per record: the
 * record less its age, its name and its lot plan's version. A record is
 * replaced on any change, and the town's ageing (a record every few seconds)
 * worked out those lots' exits, grids and aisles again for nothing.
 *
 * Beside it, the record's walls (`wallsOf`), each with its digest: a stored
 * record is never changed in place (`world/buildings/store.ts`, OWNERSHIP),
 * so what is read off it once stays true while it is stored.
 */
const RECORD_READS = new WeakMap<Building, { text?: string; walls?: readonly Wall[] }>();
function recordReads(b: Building): { text?: string; walls?: readonly Wall[] } {
  let reads = RECORD_READS.get(b);
  if (!reads) RECORD_READS.set(b, reads = {});
  return reads;
}
function lotText(b: Building): string {
  const reads = recordReads(b);
  if (reads.text === undefined) {
    const { decay: _decay, builtAt: _builtAt, name: _name, lotPlan: _lotPlan, ...lot } = b;
    reads.text = JSON.stringify(lot);
  }
  return reads.text;
}

const hasParking = (b: Building): boolean => (b.elements ?? []).some((el) => el.kind === 'parking');

/**
 * A lot's bays as last worked out, with what they were worked out from: its
 * record (`lotText`), and a digest of the lanes within reach (their lines and
 * whether they are ghosts) and of the walls within reach. A lot whose
 * surroundings are the same keeps its bays (docs/performance.md #15). The
 * bays' ids are set when the town's list is put together.
 */
interface LotBays { readonly lot: string; readonly key: number; readonly bays: readonly Bay[] }

/** The bays of a world as last worked out, and what they were worked out from. */
interface BayBook {
  /** The lots (buildings with a `parking` element), in the store's order. */
  readonly lots: BuildingsInOrder;
  readonly known: Map<BuildingId, LotBays>;
  readonly kerb: KerbBook;
  /** The roads the lots were last worked out on (`roadsKey`, the first lane object). */
  roads: string | null;
  first: unknown;
  /** The town's list, ids in order. */
  out: readonly Bay[];
}
const BOOKS = new WeakMap<SimWorld, BayBook>();

/**
 * The bays now, from the diary: the lots a building change reaches worked
 * out again, the others kept; every lot digested again when the roads moved.
 * Nothing of the town is walked unless the diary cannot say what changed.
 */
function baysNow(w: SimWorld): readonly Bay[] {
  let book = BOOKS.get(w);
  if (!book) {
    book = { lots: new BuildingsInOrder(hasParking), known: new Map(), kerb: newKerbBook(), roads: null, first: undefined, out: [] };
    BOOKS.set(w, book);
  }
  const roads = roadsKey(w);
  const first = w.graph.lanelets.values().next().value;
  const roadsMoved = book.roads !== roads || book.first !== first;
  book.roads = roads;
  book.first = first;
  const delta = book.lots.update(w.doc);
  const kerbMoved = followKerbs(w, book.kerb, roadsMoved, delta, (id) => book.lots.rank(id), (x, y, segment) => laneFor(w, x, y, undefined, segment));
  if (!roadsMoved && delta !== null && delta.ids.length === 0 && !kerbMoved) return book.out;

  // With the roads as they were, a lot whose reach no building change
  // touched keeps its bays without reading anything (the diary's rectangles).
  const rects = roadsMoved || delta === null ? null : delta.rects;
  let changed = roadsMoved || delta === null || kerbMoved;
  if (delta === null) {
    for (const id of [...book.known.keys()]) if (!book.lots.has(id)) book.known.delete(id);
  } else {
    for (const id of delta.ids) if (!book.lots.has(id) && book.known.delete(id)) changed = true;
  }
  const walls = wallsOf(w);
  const look = rects === null ? book.lots.ids : lotsReached(w, book.lots, rects, delta!.ids);
  for (const id of look) {
    const b = w.doc.buildings.get(id)!;
    const was = book.known.get(id);
    const now = lotBaysOf(w, b, was, rects, walls);
    if (now !== was) { book.known.set(id, now); changed = true; }
  }
  if (!changed) return book.out;
  const out: Bay[] = [];
  for (const id of book.lots.ids) for (const bay of book.known.get(id)!.bays) out.push({ ...bay, id: out.length });
  for (const id of book.kerb.order) for (const bay of book.kerb.bays.get(id) ?? []) out.push({ ...bay, id: out.length });
  book.out = out;
  return out;
}

/** The lots whose reach (`LOT_READS`) meets one of the rectangles, and the lots named; found by place. */
function lotsReached(w: SimWorld, lots: BuildingsInOrder, rects: readonly ChangeRect[], named: readonly BuildingId[]): Set<BuildingId> {
  const out = new Set<BuildingId>();
  for (const id of named) if (lots.has(id)) out.add(id);
  for (const r of rects) {
    for (const b of w.doc.buildings.near(r[0] - LOT_REACHED, r[1] - LOT_REACHED, r[2] + LOT_REACHED, r[3] + LOT_REACHED)) {
      if (!lots.has(b.id) || out.has(b.id)) continue;
      if (meets(r, storedBounds(b, LOT_READS))) out.add(b.id);
    }
  }
  return out;
}

const meets = (r: ChangeRect, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
  r[0] <= box.maxX && r[2] >= box.minX && r[1] <= box.maxY && r[3] >= box.minY;

/**
 * A lot's bays: as they were when its record and its reach are untouched
 * (`rects`, null: the roads moved), or when the lanes and walls within reach
 * digest the same; else worked out again.
 */
function lotBaysOf(w: SimWorld, b: Building, was: LotBays | undefined, rects: readonly ChangeRect[] | null, walls: Walls): LotBays {
  const box = storedBounds(b, LOT_READS);
  const lot = lotText(b);
  if (rects && was && was.lot === lot && !rects.some((r) => meets(r, box))) return was;
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  // The lot's key: each lane and wall within reach by its own digest
  // (`laneDigest`, `Wall.digest`), made once per lane or wall, and
  // whether the lane is a ghost now. DO NOT digest a lane's line or a
  // wall's ring here: every lot near a long street digested its whole
  // centre line again, at every building grown near it (2.7 s of a
  // 2.5 km city's growth).
  const digest = new Digest();
  const grid = laneGrid(w);
  for (const i of laneIndicesNear(grid, cx, cy, Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2)) {
    digest.add(laneDigest(grid, i)).add(w.rt(grid.lanes[i]!.id).ghost ? 1 : 0);
  }
  for (const wall of walls.inBox(box.minX, box.minY, box.maxX, box.maxY)) digest.add(wall.digest);
  const key = digest.value();
  if (was && was.lot === lot && was.key === key) return was;
  return { lot, key, bays: bayRows(w, b, walls) };
}

/** A lot's stalls, each with the way out of its lot and the lane it is reached from (ids from 0). */
function bayRows(w: SimWorld, b: Building, walls: Walls): Bay[] {
  const out: Bay[] = [];
  const navCache = new Map<object, { exits: LotExit[]; grid: LotGrid }>();
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
      const exits = property ? gateExits(w, b, property, walls) : exitsOf(w, b, lot, walls);
      const local = wallsNear(walls, b, lot).map((wl) => wl.ring.map((q) => worldToLocal(b, q)));
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
  return out;
}

/** The walls whose bounds come within a few metres of a lot, in list order. */
function wallsNear(walls: Walls, b: Building, v: { x: number; y: number; w: number; d: number }): Wall[] {
  const corners = [localToWorld(b, v.x, v.y), localToWorld(b, v.x + v.w, v.y), localToWorld(b, v.x + v.w, v.y + v.d), localToWorld(b, v.x, v.y + v.d)];
  const pad = m(3);
  const x0 = Math.min(...corners.map((c) => c.x)) - pad, x1 = Math.max(...corners.map((c) => c.x)) + pad;
  const y0 = Math.min(...corners.map((c) => c.y)) - pad, y1 = Math.max(...corners.map((c) => c.y)) + pad;
  return walls.inBox(x0, y0, x1, y1);
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
export function gateExits(w: SimWorld, b: Building, property: { x: number; y: number; w: number; d: number }, walls: Walls): LotExit[] {
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
  /** Its building and its ring, digested: its part of a lot's key (`lotBaysOf`). */
  readonly digest: number;
}

/**
 * A record's solid footprints, with their bounds and digests, made once
 * (`recordReads`): a stored record is never changed in place, so its walls -
 * and their digests - stay what they were.
 */
function recordWalls(b: Building): readonly Wall[] {
  const reads = recordReads(b);
  if (!reads.walls) {
    const made: Wall[] = [];
    for (const ring of solidFootprints(b)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const digest = new Digest().add(b.id);
      for (const p of ring) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        digest.add(p.x).add(p.y);
      }
      made.push({ building: b.id, ring, x0, y0, x1, y1, digest: digest.value() });
    }
    reads.walls = made;
  }
  return reads.walls;
}

/**
 * Every building's solid footprints, found by place: the buildings whose box
 * reaches a box (`BuildingStore.near`, in the store's order), each one's
 * footprints in order. Every building of the town was turned into walls and
 * filed in a grid each time the bays were worked out, and again for each
 * yard made (audit M3a).
 * DO NOT go back to a list of every building's walls: one change of one
 * building made it again.
 */
export class Walls {
  constructor(private readonly store: BuildingStore) {}

  /** The walls whose bounds meet a box, in the store's order. */
  inBox(x0: number, y0: number, x1: number, y1: number): Wall[] {
    const out: Wall[] = [];
    for (const b of this.store.near(x0, y0, x1, y1)) {
      for (const wl of recordWalls(b)) if (wl.x1 >= x0 && wl.x0 <= x1 && wl.y1 >= y0 && wl.y0 <= y1) out.push(wl);
    }
    return out;
  }
}

/** The town's walls, by place. */
export function wallsOf(w: SimWorld): Walls {
  return new Walls(w.doc.buildings);
}

/** Whether a car can be driven straight from `a` to `b` without its body touching a building. */
export function clearOfWalls(walls: Walls, a: { x: number; y: number }, b: { x: number; y: number },
  sweep = SWEEP, except: BuildingId | null = null): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return true;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const near = walls.inBox(Math.min(a.x, b.x) - sweep, Math.min(a.y, b.y) - sweep, Math.max(a.x, b.x) + sweep, Math.max(a.y, b.y) + sweep)
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
function exitsOf(w: SimWorld, b: Building, v: { x: number; y: number; w: number; d: number }, walls: Walls): LotExit[] {
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

