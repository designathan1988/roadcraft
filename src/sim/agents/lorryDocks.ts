import { pointInPolygon } from '@core/polygon';
import { localToWorld, worldToLocal } from '@world/buildings/geometry';
import { isDock, lorryDocks, type LorryDock } from '@world/buildings/docks';
import type { Building, BuildingElement, ElementKind } from '@world/buildings/types';
import type { Lot } from '@world/lots';
import { levelPolygons } from '@world/surfaces';
import { Level } from '@world/roadTypes';
import type { MultiPoly } from '@core/clipper';
import type { Network } from '@world/network';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { Archetype } from '../vehicles/archetypes';
import { carGates, gatedProperty, gateExits, wallsOf, type BayLane, type LotExit } from './parking';
import {
  type AxlePose, bodyClear, bodyClearExact, type Clearance, clearanceSteps, discsOf, fillRing, fillRings,
  type Solid, type Steered, type Waypoint, WaySearch,
} from './hybridAStar';

/**
 * A works' loading yard as a lorry drives it: what is solid to it, and the
 * way from the street through the yard's gate to each dock - forward, then
 * backing onto the dock - and from the dock out to the street again
 * (`lorryTraffic.ts` drives them).
 *
 * The yards are tight (a 9.8 m lorry in a yard 14.5 m deep, the docks taking
 * 12 of it; a lorry's approach is twice its length by the American Trucking
 * Associations' rule), so a way is found, not drawn: hybrid-state A*
 * (`hybridAStar.ts`) shunts the lorry about as a driver does, never turning
 * tighter than it can. It turns at the radius of AASHTO's single-unit truck
 * SU-30, whose wheelbase (6.1 m) is the drawn lorry's (6.3 m between the front
 * axle and the middle of the rear pair): 38 ft (11.6 m) at the front axle's
 * middle at full lock (TxDOT Roadway Design Manual 4.3.3, Table 4-1), so 9.7 m
 * at the rear axle's.
 *
 * Everything here is in the building's local frame; the ways are given back
 * in the world's. A dock with no way in and out takes no lorry.
 */

/** The rear axle's least turning radius (SU-30, above). */
export const LORRY_RADIUS = m(9.7);
/** Where the rear axles are, as a share of the length behind the body's centre (the drawn model's axles, `render/vehicleModels.ts` axleStations: the pair at -0.21 L and -0.34 L). */
const REAR_SHARE = 0.275;
/** Kept between the lorry and anything solid while it is planned. */
const LORRY_MARGIN = m(0.05);
/** The lorry as the planner sees it. */
export function lorryOf(a: Pick<Archetype, 'length' | 'width'>): Steered {
  return { length: a.length, width: a.width, rear: REAR_SHARE * a.length, radius: LORRY_RADIUS, margin: LORRY_MARGIN };
}

/** Cell of a yard's grid. */
const CELL = m(0.1);
/** How far beyond the lot the street is taken in, and how far from a gate along it. */
const STREET_REACH = m(16);
const STREET_WINDOW = m(22);
/** The paved mouth in front of a gate a lorry may cross the footway by: the gate's width and this much more either side. */
const MOUTH_FLARE = m(2);
/** Room left between a docked lorry's tail and the building, and a body length's stretch of lane before a gate it stops at. */
const DOCK_GAP = m(0.15);
/** The lorry stops this far before the gate on its lane and joins the lane this far past it (a lorry swings wider than a car). */
const STOP_BEFORE = m(9);
const JOIN_PAST = m(12);
/** Farthest from the dock its last straight reverse starts (nearer leaves the lorry more of the yard to turn its nose in: 40 docks of 77 against 25 at 3 m, in a test block). */
const PRE_DOCK = m(1);
/** The goal's tolerance: within this of the pose, a short leg settles the rest. */
const REACH = m(0.25);
const TURN = (4 * Math.PI) / 180;
/** Poses expanded a tick, across all the yards being planned: under a millisecond (a dock's ways, some 50 000 poses, in a few seconds of play). */
export const PLAN_BUDGET = 150;

/** What a lorry cannot drive through: what a car cannot (`lotNav.ts`), less the docks themselves. */
const SOLID: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'stair', 'ramp', 'pillar', 'wall', 'fence', 'tree', 'bench', 'planter', 'railing', 'rocks', 'clock', 'hedge',
  'shrub', 'bin', 'lamp', 'bollard', 'parking',
]);
/** Parts this high or higher stand over a lorry (3.5 m tall). */
const OVER_A_LORRY = m(4.2);

type Plan = { search: WaySearch | null; way: Waypoint[] | null; done: boolean };

export interface YardGate {
  readonly exit: LotExit;
  readonly lane: BayLane;
  /** Where the lorry stands on its lane before the gate, and joins it past the gate (local, rear axle). */
  readonly stop: AxlePose;
  readonly stopAt: number;
  readonly join: AxlePose;
  readonly joinAt: number;
}

export interface YardDock {
  readonly dock: LorryDock;
  /** The lorry on the dock (local, rear axle), and the start of its last straight reverse. */
  readonly docked: AxlePose;
  readonly pre: AxlePose;
  /** Through which gate, and the ways: from the stop before the gate to `pre`; from `pre` out to the gate's join. */
  gate: number;
  readonly onto: Plan[];
  readonly away: Plan[];
  /** The gates in the order they are tried: the nearest the dock first. */
  readonly order: number[];
}

/** A way a lorry drives, in the world: rear-axle poses with the direction each is reached in. */
export interface LorryWay {
  readonly poses: readonly Waypoint[];
  /** Where, along `poses`, the street part ends (arriving) or begins (leaving): the lanes it crosses are closed meanwhile. */
  readonly street: number;
}

export class Yard {
  readonly gates: YardGate[] = [];
  readonly docks: YardDock[] = [];
  readonly solid: Solid;
  readonly field: Clearance;
  readonly body: Steered;
  /** The lot's ring, local. */
  readonly ring: { x: number; y: number }[];

  /** Made by `buildYard`, whose grid and clearance it takes; here its gates and docks are worked out. */
  constructor(readonly building: Building, readonly key: string, w: SimWorld, body: Steered, made: YardGrid) {
    this.body = body;
    const b = building;
    this.ring = made.ring;
    const exits = made.exits;
    const solid = made.solid;
    this.solid = solid;
    this.field = made.field;

    for (const exit of exits) {
      if (!exit.outer || exit.lane.entryAt === undefined) continue;
      const lane = w.lanelet(exit.lane.lanelet);
      if (!lane) continue;
      // The gate's foot on its lane.
      const foot = lane.centre.closestPoint(localToWorld(b, exit.outer.x, exit.outer.y)).s;
      const stopAt = Math.max(m(1), foot - STOP_BEFORE), joinAt = Math.min(lane.length - m(1), foot + JOIN_PAST);
      const pose = (s: number): AxlePose => {
        const f = lane.centre.sampleAt(s);
        const p = worldToLocal(b, f.p), t = localDir(b, f.t.x, f.t.y);
        const angle = Math.atan2(t.y, t.x);
        return { x: p.x - Math.cos(angle) * body.rear, y: p.y - Math.sin(angle) * body.rear, angle };
      };
      this.gates.push({ exit, lane: exit.lane, stop: pose(stopAt), stopAt, join: pose(joinAt), joinAt });
    }
    for (const dock of lorryDocks(b)) {
      const door = worldToLocal(b, dock.door), open = worldToLocal(b, dock.open);
      const ol = Math.hypot(open.x - door.x, open.y - door.y);
      const ox = (open.x - door.x) / ol, oy = (open.y - door.y) / ol;
      const angle = Math.atan2(oy, ox);
      const centre = body.length / 2 + DOCK_GAP;
      const docked = { x: door.x + ox * (centre - body.rear), y: door.y + oy * (centre - body.rear), angle };
      // The farthest out (up to `PRE_DOCK`) its straight reverse onto the dock can start, the body clear there.
      const discs = discsOf(body);
      let pre: AxlePose | null = null;
      for (let d = PRE_DOCK; d >= m(0.25); d -= m(0.25)) {
        const at = { x: docked.x + ox * d, y: docked.y + oy * d, angle };
        if (bodyClear(this.field, discs, at.x, at.y, at.angle) && straightClear(solid, body, at, docked)) { pre = at; break; }
      }
      const order = this.gates.map((_, g) => g).sort((p, q) => gateDistance(this.gates[p]!, open) - gateDistance(this.gates[q]!, open));
      this.docks.push({
        dock, docked, pre: pre ?? docked, gate: -1, order,
        onto: this.gates.map(() => ({ search: null, way: null, done: !pre })),
        away: this.gates.map(() => ({ search: null, way: null, done: !pre })),
      });
    }
  }

  /**
   * Plans on, up to `budget` poses expanded; how many it spent. A dock is
   * planned through each gate in turn (the nearest first) until one way in
   * and out is found: in from the stop before the gate, backing onto the
   * dock; out from the dock to the lane past the same gate.
   */
  plan(dockIndex: number, budget: number): number {
    const dock = this.docks[dockIndex]!;
    let spent = 0;
    for (const g of dock.order) {
      if (dock.gate >= 0 || spent >= budget) return spent;
      const gate = this.gates[g]!;
      const onto = dock.onto[g]!;
      spent += this.step(onto, budget - spent, () => new WaySearch(this.field, this.body, gate.stop, dock.pre,
        { arriveReversing: true, reach: REACH, turn: TURN }));
      if (!onto.done) return spent;
      if (onto.way && !this.settles(last(onto.way), dock.pre, true)) onto.way = null;
      if (!onto.way) continue;
      const away = dock.away[g]!;
      spent += this.step(away, budget - spent, () => new WaySearch(this.field, this.body, dock.pre, gate.join,
        { arriveReversing: false, reach: REACH, turn: TURN }));
      if (!away.done) return spent;
      if (away.way && !this.settles(last(away.way), gate.join, false)) away.way = null;
      if (!away.way) continue;
      dock.gate = g;
    }
    return spent;
  }

  /** Whether a dock's planning is over (`gate` then says through which gate, -1 for none). */
  planned(dockIndex: number): boolean {
    const dock = this.docks[dockIndex]!;
    if (dock.gate >= 0) return true;
    return dock.order.every((g) => dock.onto[g]!.done && (!dock.onto[g]!.way || dock.away[g]!.done));
  }

  /** The way in to a planned dock and out of it, in the world; null when it has none. */
  ways(dockIndex: number): { into: LorryWay; away: LorryWay; gate: YardGate } | null {
    const dock = this.docks[dockIndex]!;
    if (dock.gate < 0) return null;
    const gate = this.gates[dock.gate]!;
    const into = dock.onto[dock.gate]!.way!;
    // Arriving, the street ends where the whole body first stands in the lot.
    let intoStreet = into.length - 1;
    for (let i = 0; i < into.length; i++) if (this.bodyInLot(into[i]!)) { intoStreet = i; break; }
    const settleIn = settle(last(into), dock.pre, true);
    const toDock = straight(dock.pre, dock.docked, true);
    const intoAll = [...into, ...settleIn.slice(1), ...toDock.slice(1)];
    const outOfDock = straight(dock.docked, dock.pre, false);
    const away = dock.away[dock.gate]!.way!;
    const awayAll = [...outOfDock, ...away.slice(1), ...settle(last(away), gate.join, false).slice(1)];
    // Leaving, the street begins where the body first leaves the lot.
    let awayStreet = awayAll.length - 1;
    for (let i = 0; i < awayAll.length; i++) if (!this.bodyInLot(awayAll[i]!)) { awayStreet = Math.max(0, i - 1); break; }
    return {
      into: { poses: intoAll.map((p) => this.toWorld(p)), street: intoStreet },
      away: { poses: awayAll.map((p) => this.toWorld(p)), street: awayStreet },
      gate,
    };
  }

  /** Whether the whole body at a pose stands in the lot. */
  bodyInLot(p: AxlePose): boolean {
    if (!this.ring.length) return false;
    const { body } = this;
    const c = Math.cos(p.angle), s = Math.sin(p.angle);
    const back = body.length / 2 - body.rear, front = body.length / 2 + body.rear, hw = body.width / 2;
    for (const [u, v] of [[-back, -hw], [-back, hw], [front, -hw], [front, hw]] as const) {
      if (!pointInPolygon({ x: p.x + c * u - s * v, y: p.y + s * u + c * v }, this.ring)) return false;
    }
    return true;
  }

  private toWorld(p: Waypoint): Waypoint {
    const q = localToWorld(this.building, p.x, p.y);
    return { x: q.x, y: q.y, angle: p.angle + this.building.rotation, reverse: p.reverse };
  }

  private step(plan: Plan, budget: number, make: () => WaySearch): number {
    if (plan.done || budget <= 0) return 0;
    const search = plan.search ??= make();
    const before = search.expanded;
    search.run(budget);
    if (search.state !== 'running') {
      plan.way = search.way;
      plan.done = true;
      plan.search = null;
    }
    // A search that ended at once (no room at its start) still costs a look.
    return Math.max(1, search.expanded - before);
  }

  /** Whether the short leg from where a search stopped to its exact goal is clear, cell by cell. */
  private settles(from: AxlePose, to: AxlePose, reverse: boolean): boolean {
    return settle(from, to, reverse).every((p) => bodyClearExact(this.solid, this.body, p.x, p.y, p.angle, m(0.02)));
  }
}

/** A yard's grid as `buildYard` fills it, before its gates and docks. */
interface YardGrid {
  readonly ring: { x: number; y: number }[];
  readonly exits: LotExit[];
  readonly solid: Solid;
  readonly field: Clearance;
}

/**
 * Cells of work a slice of a yard's making: some 2 ms. A yard's grid (cells
 * of 10 cm, a third of a million) was filled and its clearance worked out in
 * one tick - 30 ms, the simulation's worst tick in the game (2026-10-13); now
 * over a dozen.
 */
const YARD_SLICE = 40_000;

/** Cell of the grid the lots and buildings near a yard are found by (`yardNeighbours`). */
const NEIGHBOUR_CELL = m(64);

/**
 * The lots by cell of a coarse grid, and each building's lot: what a yard
 * looks up, not the whole map. The buildings near a yard are asked of the
 * store by place (`BuildingStore.near`).
 */
export interface YardNeighbours {
  readonly key: string;
  readonly lotOf: ReadonlyMap<number, Lot>;
  readonly cells: ReadonlyMap<number, { readonly lots: Lot[] }>;
}

const neighbourCell = (i: number, j: number): number => i * 100_003 + j;

/**
 * The town's lots filed by cell, made again only when the lots change: a
 * yard asks for the cells over its grid (it went through every lot and every
 * building of the map, each turned into its frame).
 * DO NOT file the buildings here again: keyed on the buildings' revision,
 * the town's ageing filed every building of the map again every few seconds.
 * @rebuild Its work runs when the lots changed.
 */
export function yardNeighbours(w: SimWorld, known: YardNeighbours | null): YardNeighbours {
  const key = `${w.doc.lotRevision}`;
  if (known && known.key === key) return known;
  const lotOf = new Map<number, Lot>();
  const cells = new Map<number, { lots: Lot[] }>();
  const file = (x0: number, y0: number, x1: number, y1: number, put: (c: { lots: Lot[] }) => void): void => {
    for (let i = Math.floor(x0 / NEIGHBOUR_CELL); i <= Math.floor(x1 / NEIGHBOUR_CELL); i++) {
      for (let j = Math.floor(y0 / NEIGHBOUR_CELL); j <= Math.floor(y1 / NEIGHBOUR_CELL); j++) {
        const k = neighbourCell(i, j);
        let c = cells.get(k);
        if (!c) cells.set(k, c = { lots: [] });
        put(c);
      }
    }
  };
  for (const lot of w.doc.lots) {
    if (lot.building !== undefined) lotOf.set(lot.building, lot);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of lot.corners) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    file(x0, y0, x1, y1, (c) => c.lots.push(lot));
  }
  return { key, lotOf, cells };
}

/** The lots filed in the cells over a box of the world, each once. */
function lotsNear(index: YardNeighbours, x0: number, y0: number, x1: number, y1: number): Set<Lot> {
  const lots = new Set<Lot>();
  for (let i = Math.floor(x0 / NEIGHBOUR_CELL); i <= Math.floor(x1 / NEIGHBOUR_CELL); i++) {
    for (let j = Math.floor(y0 / NEIGHBOUR_CELL); j <= Math.floor(y1 / NEIGHBOUR_CELL); j++) {
      const c = index.cells.get(neighbourCell(i, j));
      if (!c) continue;
      for (const lot of c.lots) lots.add(lot);
    }
  }
  return lots;
}

/**
 * Makes a yard a slice at a time: what is solid to a lorry filled in its
 * grid - from what is near the yard only (the roads and buildings of the
 * whole map were each turned into the yard's frame) - then its clearance.
 */
export function* buildYard(b: Building, key: string, w: SimWorld, body: Steered, index: YardNeighbours): Generator<void, Yard, void> {
  const prop = gatedProperty(b)!;
  const lot = index.lotOf.get(b.id);
  const ring = lot ? lot.corners.map((q) => worldToLocal(b, q)) : [];
  const exits = gateExits(w, b, prop, wallsOf(w));
  const x0 = prop.x - STREET_REACH, y0 = prop.y - STREET_REACH;
  const nx = Math.ceil((prop.w + 2 * STREET_REACH) / CELL), ny = Math.ceil((prop.d + 2 * STREET_REACH) / CELL);
  const solid: Solid = { x0, y0, cell: CELL, nx, ny, blocked: new Uint8Array(nx * ny).fill(1) };
  const box = { x0: x0, y0: y0, x1: x0 + nx * CELL, y1: y0 + ny * CELL };
  // The grid's box in the world, for what is near it.
  const corners = [localToWorld(b, box.x0, box.y0), localToWorld(b, box.x1, box.y0), localToWorld(b, box.x1, box.y1), localToWorld(b, box.x0, box.y1)];
  const wx0 = Math.min(...corners.map((q) => q.x)), wx1 = Math.max(...corners.map((q) => q.x));
  const wy0 = Math.min(...corners.map((q) => q.y)), wy1 = Math.max(...corners.map((q) => q.y));
  // The buildings that may stand over the grid, as they stand when the yard
  // is begun (a superset: a ring off the grid fills no cell).
  const buildingsNear = w.doc.buildings.near(wx0, wy0, wx1, wy1);
  // Open: the lot, the carriageways round it and each gate's mouth across the footway.
  if (ring.length) fillRing(solid, ring, 0);
  for (const { rings: world, box: wb } of asphaltOf(w.net)) {
    if (wb.x1 < wx0 || wb.x0 > wx1 || wb.y1 < wy0 || wb.y0 > wy1) continue;
    fillRings(solid, world.map((r) => r.map(([x, y]) => worldToLocal(b, { x: x!, y: y! }))), 0);
  }
  yield;
  const gates = carGates(b);
  for (const exit of exits) {
    if (!exit.outer) continue;
    const ux = exit.outer.x - exit.inner.x, uy = exit.outer.y - exit.inner.y, ul = Math.hypot(ux, uy);
    const ox = ux / ul, oy = uy / ul, tx = -oy, ty = ox;
    const gx = exit.outer.x - ox * m(1.2), gy = exit.outer.y - oy * m(1.2);
    const gate = nearestGate(gates, gx, gy);
    const half = (gate?.w ?? m(5)) / 2 + MOUTH_FLARE, far = exit.out + m(2);
    fillRing(solid, [
      { x: gx - tx * half, y: gy - ty * half }, { x: gx + tx * half, y: gy + ty * half },
      { x: gx + tx * half + ox * far, y: gy + ty * half + oy * far }, { x: gx - tx * half + ox * far, y: gy - ty * half + oy * far },
    ], 0);
  }
  // Only the street near a gate: a lorry turns in and out there, and the
  // search does not wander the whole frontage (each street cell is a few
  // hundred poses more to try). The lot's own cells by a mask of its ring,
  // not a point-in-polygon test a cell.
  const inLot: Solid = { x0, y0, cell: CELL, nx, ny, blocked: new Uint8Array(nx * ny) };
  if (ring.length) fillRing(inLot, ring, 1);
  const mouths = exits.filter((e) => e.outer).map((e) => e.outer!);
  const window2 = STREET_WINDOW * STREET_WINDOW;
  let work = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (solid.blocked[k] || inLot.blocked[k]) continue;
      const x = x0 + (i + 0.5) * CELL, y = y0 + (j + 0.5) * CELL;
      let near = false;
      for (const q of mouths) if ((q.x - x) * (q.x - x) + (q.y - y) * (q.y - y) <= window2) { near = true; break; }
      if (!near) solid.blocked[k] = 1;
    }
    if ((work += nx) >= YARD_SLICE) { work = 0; yield; }
  }
  // Shut: every other lot near, every building's walls near, this lot's solid parts (and its car stalls).
  for (const other of lotsNear(index, wx0, wy0, wx1, wy1)) {
    if (other === lot) continue;
    fillRing(solid, other.corners.map((q) => worldToLocal(b, q)), 1);
  }
  for (const o of buildingsNear) {
    for (const v of o.volumes) {
      if (v.open) continue;
      const vring = [localToWorld(o, v.x, v.y), localToWorld(o, v.x + v.w, v.y), localToWorld(o, v.x + v.w, v.y + v.d), localToWorld(o, v.x, v.y + v.d)]
        .map((q) => worldToLocal(b, q));
      if (vring.every((q) => q.x < box.x0 || q.x > box.x1) || vring.every((q) => q.y < box.y0 || q.y > box.y1)) continue;
      fillRing(solid, vring, 1);
    }
  }
  for (const el of b.elements ?? []) {
    if (!SOLID.has(el.kind) || el.z >= OVER_A_LORRY || isDock(el)) continue;
    fillRing(solid, elementRing(el), 1);
  }
  yield;
  const field = yield* clearanceSteps(solid, YARD_SLICE);
  return new Yard(b, key, w, body, { ring, exits, solid, field });
}

/** The yards of a world, made when first asked and again when their building or the roads change. */
const YARDS = new WeakMap<SimWorld, Map<number, Yard>>();

/** What a yard is made from: the roads and the buildings as they stand. */
export const yardKey = (w: SimWorld): string => `${w.topologyRevision}:${w.graph.revision}:${w.net.revision}`;

/** A building's yard as already made: null when it has none, undefined when it must be made (`buildYard`). */
export function knownYard(w: SimWorld, b: Building): Yard | null | undefined {
  if (!gatedProperty(b) || !lorryDocks(b).length) return null;
  const known = YARDS.get(w)?.get(b.id);
  return known && known.building === b && known.key === yardKey(w) ? known : undefined;
}

/** Keeps a yard made (`buildYard`) for its building. */
export function keepYard(w: SimWorld, yard: Yard): void {
  let byBuilding = YARDS.get(w);
  if (!byBuilding) YARDS.set(w, byBuilding = new Map());
  byBuilding.set(yard.building.id, yard);
}

/** The yard of a building as it stands now, made to the end at once if it must be (probes and specs). */
export function yardOf(w: SimWorld, b: Building, body: Steered): Yard | null {
  const known = knownYard(w, b);
  if (known !== undefined) return known;
  const steps = buildYard(b, yardKey(w), w, body, yardNeighbours(w, null));
  for (;;) {
    const next = steps.next();
    if (next.done) { keepYard(w, next.value); return next.value; }
  }
}

// ------------------------------------------------------------------ helpers

/** The carriageways' polygons, each with its box in the world: a yard takes in only those near it. */
type AsphaltPiece = { readonly rings: MultiPoly[number]; readonly box: { x0: number; y0: number; x1: number; y1: number } };
const ASPHALT = new WeakMap<Network, { revision: number; pieces: AsphaltPiece[] }>();
function asphaltOf(net: Network): readonly AsphaltPiece[] {
  const known = ASPHALT.get(net);
  if (known && known.revision === net.revision) return known.pieces;
  const pieces = levelPolygons(net, Level.Asphalt as never).map((rings): AsphaltPiece => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0] ?? []) { x0 = Math.min(x0, x!); x1 = Math.max(x1, x!); y0 = Math.min(y0, y!); y1 = Math.max(y1, y!); }
    return { rings, box: { x0, y0, x1, y1 } };
  });
  ASPHALT.set(net, { revision: net.revision, pieces });
  return pieces;
}

/** How far a gate's inside is from a dock's open end. */
function gateDistance(gate: YardGate, open: { x: number; y: number }): number {
  return Math.hypot(gate.exit.inner.x - open.x, gate.exit.inner.y - open.y);
}

function nearestGate(gates: readonly BuildingElement[], x: number, y: number): BuildingElement | undefined {
  let best: BuildingElement | undefined, bestD = Infinity;
  for (const g of gates) {
    const d = Math.hypot(g.x - x, g.y - y);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

function elementRing(el: BuildingElement): { x: number; y: number }[] {
  const alongY = el.facing === 0 || el.facing === 2;
  const hx = (alongY ? el.w : el.d) / 2, hy = (alongY ? el.d : el.w) / 2;
  const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => ({ x: el.x + u! * c - v! * s, y: el.y + u! * s + v! * c }));
}

function localDir(b: Building, dx: number, dy: number): { x: number; y: number } {
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

const last = <T>(list: readonly T[]): T => list[list.length - 1]!;


/** Spacing of the poses on a settling leg. */
const SETTLE_STEP = m(0.2);

/**
 * A short leg from a pose to another, driven forward or backing: the rear
 * axle along a cubic Hermite curve whose ends point along the two headings
 * (the way `manoeuvre.ts` joins its points), the body along the curve.
 */
export function settle(from: AxlePose, to: AxlePose, reverse: boolean): Waypoint[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const dir = reverse ? -1 : 1;
  const k = 0.6 * len;
  const t0x = Math.cos(from.angle) * dir, t0y = Math.sin(from.angle) * dir;
  const t1x = Math.cos(to.angle) * dir, t1y = Math.sin(to.angle) * dir;
  const n = Math.max(1, Math.ceil(len / SETTLE_STEP));
  const out: Waypoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const x = h00 * from.x + h10 * k * t0x + h01 * to.x + h11 * k * t1x;
    const y = h00 * from.y + h10 * k * t0y + h01 * to.y + h11 * k * t1y;
    const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
    const dx = d00 * from.x + d10 * k * t0x + d01 * to.x + d11 * k * t1x;
    const dy = d00 * from.y + d10 * k * t0y + d01 * to.y + d11 * k * t1y;
    const moving = Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : from.angle + (reverse ? Math.PI : 0);
    const angle = i === 0 ? from.angle : i === n ? to.angle : moving + (reverse ? Math.PI : 0);
    out.push({ x, y, angle, reverse });
  }
  return out;
}

/** A straight leg (both poses on one line, one heading). */
function straight(from: AxlePose, to: AxlePose, reverse: boolean): Waypoint[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(len / SETTLE_STEP));
  const out: Waypoint[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n, angle: to.angle, reverse });
  return out;
}

function straightClear(solid: Solid, body: Steered, from: AxlePose, to: AxlePose): boolean {
  return straight(from, to, true).every((p) => bodyClearExact(solid, body, p.x, p.y, p.angle, m(0.02)));
}
