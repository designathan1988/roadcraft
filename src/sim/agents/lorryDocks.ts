import { pointInPolygon } from '@core/polygon';
import { localToWorld, worldToLocal } from '@world/buildings/geometry';
import { isDock, type LorryDock } from '@world/buildings/docks';
import type { ElementKind } from '@world/buildings/types';
import type { Lot } from '@world/lots';
import type { TrafficBuilding, TrafficPart } from './trafficBuildings';
import type { LotPart } from './lotNav';
import { levelRingsOf } from '@world/surfaces';
import { Level } from '@world/roadTypes';
import type { MultiPoly } from '@core/clipper';
import { Digest } from '@core/digest';
import type { Network } from '@world/network';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { m } from '@world/units';
import type { SimWorld } from '../world';
import type { Archetype } from '../vehicles/archetypes';
import { carGates, gatedProperty, gateExits, lanesInBox, wallsOf, type BayLane, type LotExit } from './parking';
import {
  type AxlePose, bodyClear, bodyClearExact, type Clearance, clearanceSteps, discsOf, fillRing, fillRings,
  type Holonomic, type Solid, type Steered, type Waypoint, WaySearch,
} from './hybridAStar';

/** A works' loading yard as a lorry drives it */

/** The rear axle's least turning radius (SU-30, above). */
const LORRY_RADIUS = m(9.7);
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
  /** The grid and its clearance, while a dock is still to be planned: DO NOT keep them for the yard's life (a works' grid is some 100 000 cells, ~0.5 MB with its clearance, a yard of the map each). */
  private grids: { readonly solid: Solid; readonly field: Clearance } | null;
  /** The distance maps of the searches on this yard's field, by goal (a dock's ways in from every gate share one): let go with the grids. */
  private maps = new Map<string, Holonomic>();
  readonly body: Steered;
  /** The lot's ring, local. */
  readonly ring: { x: number; y: number }[];

  /** What it was made from, near it (`yardInputs`): it stands while these do, whatever changed elsewhere. */
  readonly inputs: number;
  /** The world box its grid covers: the lots and buildings it reads are those the diary places there. */
  readonly reach: ChangeRect;
  /** The diary's serial its inputs were last read at (`knownYard`). */
  seen: number;

  /** Made by `buildYard`, whose grid and clearance it takes; here its gates and docks are worked out. */
  constructor(readonly building: TrafficBuilding, public key: string, w: SimWorld, body: Steered, made: YardGrid) {
    this.body = body;
    this.inputs = made.inputs;
    this.reach = made.reach;
    this.seen = made.seen;
    const b = building;
    this.ring = made.ring;
    const exits = made.exits;
    const solid = made.solid;
    this.grids = { solid, field: made.field };

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
    for (const dock of b.docks) {
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
        if (bodyClear(made.field, discs, at.x, at.y, at.angle) && straightClear(solid, body, at, docked)) { pre = at; break; }
      }
      const order = this.gates.map((_, g) => g).sort((p, q) => gateDistance(this.gates[p]!, open) - gateDistance(this.gates[q]!, open));
      this.docks.push({
        dock, docked, pre: pre ?? docked, gate: -1, order,
        onto: this.gates.map(() => ({ search: null, way: null, done: !pre })),
        away: this.gates.map(() => ({ search: null, way: null, done: !pre })),
      });
    }
  }

  /** The yard's grid, while it is kept (`plan` lets it go once every dock is planned). */
  get solid(): Solid {
    if (!this.grids) throw new Error("[lorries] a yard's grid read after every dock was planned");
    return this.grids.solid;
  }

  get field(): Clearance {
    if (!this.grids) throw new Error("[lorries] a yard's clearance read after every dock was planned");
    return this.grids.field;
  }

  /** Plans on, up to `budget` poses expanded; how many it spent. Every dock planned, the grids are let go (the ways keep only poses). */
  plan(dockIndex: number, budget: number): number {
    const spent = this.planDock(dockIndex, budget);
    if (this.grids && this.docks.every((_, k) => this.planned(k))) { this.grids = null; this.maps = new Map(); }
    return spent;
  }

  private planDock(dockIndex: number, budget: number): number {
    const dock = this.docks[dockIndex]!;
    let spent = 0;
    for (const g of dock.order) {
      if (dock.gate >= 0 || spent >= budget) return spent;
      const gate = this.gates[g]!;
      const onto = dock.onto[g]!;
      spent += this.step(onto, budget - spent, () => new WaySearch(this.field, this.body, gate.stop, dock.pre,
        { arriveReversing: true, reach: REACH, turn: TURN, maps: this.maps }));
      if (!onto.done) return spent;
      if (onto.way && !this.settles(last(onto.way), dock.pre, true)) onto.way = null;
      if (!onto.way) continue;
      const away = dock.away[g]!;
      spent += this.step(away, budget - spent, () => new WaySearch(this.field, this.body, dock.pre, gate.join,
        { arriveReversing: false, reach: REACH, turn: TURN, maps: this.maps }));
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
  readonly inputs: number;
  readonly reach: ChangeRect;
  readonly seen: number;
  readonly ring: { x: number; y: number }[];
  readonly exits: LotExit[];
  readonly solid: Solid;
  readonly field: Clearance;
}

/** Cells of work a slice of a yard's making: some 2 ms. */
const YARD_SLICE = 40_000;

/** What a yard reads near it besides the roads: a change of these there is looked at (`knownYard`), elsewhere never. */
const NEAR_KINDS: readonly ChangeKind[] = ['lots', 'buildings'];

/** DO NOT file the town's lots again for a yard: the lot store's own index by place, kept by its writers (`RoadDoc.lotsIn`). */
function lotsNear(w: SimWorld, x0: number, y0: number, x1: number, y1: number): Lot[] {
  return w.doc.lotsIn([x0, y0, x1, y1]);
}

/** A building's own lot among those near it: the last in the lots' order, as one filing of the whole map kept it. */
function ownLot(w: SimWorld, b: TrafficBuilding, lots: readonly Lot[]): Lot | undefined {
  let best: Lot | undefined, bestOrder = -Infinity;
  for (const lot of lots) {
    if (lot.building !== b.id) continue;
    const order = w.doc.lotStore.orderOf(lot.id) ?? -1;
    if (order >= bestOrder) { best = lot; bestOrder = order; }
  }
  return best;
}

/** Makes a yard a slice at a time: what is solid to a lorry filled in its grid - from what is near the yard only */
export function* buildYard(b: TrafficBuilding, key: string, w: SimWorld, body: Steered): Generator<void, Yard, void> {
  const prop = gatedProperty(b)!;
  const { x0, y0, nx, ny, box, wx0, wy0, wx1, wy1 } = yardBox(b, prop);
  const reach: ChangeRect = [wx0, wy0, wx1, wy1];
  const seen = w.doc.changes.version;
  const lots = lotsNear(w, wx0, wy0, wx1, wy1);
  const inputs = yardInputs(w, b, lots);
  const lot = ownLot(w, b, lots);
  const ring = lot ? lot.corners.map((q) => worldToLocal(b, q)) : [];
  const exits = gateExits(w, b, prop, wallsOf(w));
  const solid: Solid = { x0, y0, cell: CELL, nx, ny, blocked: new Uint8Array(nx * ny).fill(1) };
  // Open: the lot, the carriageways round it and each gate's mouth across the footway.
  if (ring.length) fillRing(solid, ring, 0);
  for (const { rings: world } of asphaltNear(w.net, wx0, wy0, wx1, wy1)) {
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
  // Only the street near a gate: a lorry turns in and out there, and the search does not wander the whole frontage
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
  for (const other of lots) {
    if (other === lot) continue;
    fillRing(solid, other.corners.map((q) => worldToLocal(b, q)), 1);
  }
  for (const o of w.buildings.near(wx0, wy0, wx1, wy1)) {
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
  return new Yard(b, key, w, body, { inputs, reach, seen, ring, exits, solid, field });
}

/** A yard's grid (local frame: its corner, cells across and down, its box) and the grid's box in the world. */
function yardBox(b: TrafficBuilding, prop: { x: number; y: number; w: number; d: number }) {
  const x0 = prop.x - STREET_REACH, y0 = prop.y - STREET_REACH;
  const nx = Math.ceil((prop.w + 2 * STREET_REACH) / CELL), ny = Math.ceil((prop.d + 2 * STREET_REACH) / CELL);
  const box = { x0: x0, y0: y0, x1: x0 + nx * CELL, y1: y0 + ny * CELL };
  const corners = [localToWorld(b, box.x0, box.y0), localToWorld(b, box.x1, box.y0), localToWorld(b, box.x1, box.y1), localToWorld(b, box.x0, box.y1)];
  const wx0 = Math.min(...corners.map((q) => q.x)), wx1 = Math.max(...corners.map((q) => q.x));
  const wy0 = Math.min(...corners.map((q) => q.y)), wy1 = Math.max(...corners.map((q) => q.y));
  return { x0, y0, nx, ny, box, wx0, wy0, wx1, wy1 };
}

/** How far from a yard's grid the lanes its gates may be joined to are read (`parking.ts` gateLane's reach, and a margin). */
const GATE_LANES_READ = m(45) + m(5);

/** What a yard is made from, near it, as one number: the lanes its gates may be joined to */
export function yardInputs(w: SimWorld, b: TrafficBuilding, lots?: readonly Lot[]): number {
  const prop = gatedProperty(b);
  if (!prop) return 0;
  const { wx0, wy0, wx1, wy1 } = yardBox(b, prop);
  const d = new Digest();
  for (const lane of lanesInBox(w, wx0 - GATE_LANES_READ, wy0 - GATE_LANES_READ, wx1 + GATE_LANES_READ, wy1 + GATE_LANES_READ)) {
    d.addText(lane.id).add(lane.length).addAll(lane.centre.xy);
  }
  for (const { rings } of asphaltNear(w.net, wx0, wy0, wx1, wy1)) {
    for (const ring of rings) for (const [x, y] of ring) d.add(x!).add(y!);
  }
  for (const lot of lots ?? lotsNear(w, wx0, wy0, wx1, wy1)) for (const q of lot.corners) d.add(q.x).add(q.y);
  for (const o of w.buildings.near(wx0, wy0, wx1, wy1)) {
    d.add(o.id).add(o.x).add(o.y).add(o.rotation);
    for (const v of o.volumes) d.add(v.x).add(v.y).add(v.w).add(v.d).add(v.open ? 1 : 0);
  }
  return d.value();
}

/** The yards of a world, made when first asked and again when their building or the roads change */
interface WorldYards { readonly byBuilding: Map<number, Yard> }
const YARDS = new WeakMap<SimWorld, WorldYards>();
function yardsOf(w: SimWorld): WorldYards {
  let yards = YARDS.get(w);
  if (!yards) YARDS.set(w, yards = { byBuilding: new Map() });
  return yards;
}

/** The roads as they stand: a yard known good for them needs no look (`knownYard`). */
export const yardKey = (w: SimWorld): string => `${w.topologyRevision}:${w.graph.revision}:${w.net.revision}`;

/** DO NOT throw a yard away on `yardKey` alone, nor on a lot changed anywhere: its inputs are read again only when the roads moved or the diary places a lot or a building change on its grid */
export function knownYard(w: SimWorld, b: TrafficBuilding): Yard | null | undefined {
  if (!gatedProperty(b) || !b.docks.length) return null;
  const known = YARDS.get(w)?.byBuilding.get(b.id);
  if (!known || known.building !== b) return undefined;
  const key = yardKey(w);
  const diary = w.doc.changes;
  if (known.key === key && !diary.touches(known.seen, known.reach, NEAR_KINDS)) {
    known.seen = diary.version;
    return known;
  }
  if (yardInputs(w, b) !== known.inputs) return undefined;
  known.key = key;
  known.seen = diary.version;
  return known;
}

/** A building's yard forgotten: its building gone, or no longer one with a yard (`lorryTraffic.ts` YardList). */
export function forgetYard(w: SimWorld, building: number): void {
  YARDS.get(w)?.byBuilding.delete(building);
}

/** @rebuild The yards of the buildings `keep` turns down forgotten: when the town's yards were read whole. */
export function forgetYardsBut(w: SimWorld, keep: (building: number) => boolean): void {
  const byBuilding = YARDS.get(w)?.byBuilding;
  if (!byBuilding) return;
  for (const id of [...byBuilding.keys()]) if (!keep(id)) byBuilding.delete(id);
}

/** Keeps a yard made (`buildYard`) for its building. */
export function keepYard(w: SimWorld, yard: Yard): void {
  yardsOf(w).byBuilding.set(yard.building.id, yard);
}

/** The yard of a building as it stands now, made to the end at once if it must be (probes and specs). */
export function yardOf(w: SimWorld, b: TrafficBuilding, body: Steered): Yard | null {
  const known = knownYard(w, b);
  if (known !== undefined) return known;
  const steps = buildYard(b, yardKey(w), w, body);
  for (;;) {
    const next = steps.next();
    if (next.done) { keepYard(w, next.value); return next.value; }
  }
}

// ------------------------------------------------------------------ helpers

/** The carriageways' polygons, each with its box in the world: a yard takes in only those near it. */
type AsphaltPiece = { readonly rings: MultiPoly[number]; readonly box: { x0: number; y0: number; x1: number; y1: number } };

/** DO NOT merge the whole map's carriageways for a yard (`levelPolygons`) */
function asphaltNear(net: Network, x0: number, y0: number, x1: number, y1: number): AsphaltPiece[] {
  const box: readonly [number, number, number, number] = [x0, y0, x1, y1];
  const junctions = net.junctionCells.idsMeeting(box).flatMap((id) => {
    const at = net.junctions.get(id);
    return at ? [[id, at] as const] : [];
  });
  const out: AsphaltPiece[] = [];
  for (const rings of levelRingsOf(net, Level.Asphalt as never, net.ribbonsMeeting(box), junctions)) {
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const [x, y] of rings[0] ?? []) { px0 = Math.min(px0, x!); px1 = Math.max(px1, x!); py0 = Math.min(py0, y!); py1 = Math.max(py1, y!); }
    if (px1 < x0 || px0 > x1 || py1 < y0 || py0 > y1) continue;
    out.push({ rings, box: { x0: px0, y0: py0, x1: px1, y1: py1 } });
  }
  return out;
}

/** How far a gate's inside is from a dock's open end. */
function gateDistance(gate: YardGate, open: { x: number; y: number }): number {
  return Math.hypot(gate.exit.inner.x - open.x, gate.exit.inner.y - open.y);
}

function nearestGate(gates: readonly TrafficPart[], x: number, y: number): TrafficPart | undefined {
  let best: TrafficPart | undefined, bestD = Infinity;
  for (const g of gates) {
    const d = Math.hypot(g.x - x, g.y - y);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

function elementRing(el: LotPart): { x: number; y: number }[] {
  const alongY = el.facing === 0 || el.facing === 2;
  const hx = (alongY ? el.w : el.d) / 2, hy = (alongY ? el.d : el.w) / 2;
  const c = Math.cos(el.angle ?? 0), s = Math.sin(el.angle ?? 0);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => ({ x: el.x + u! * c - v! * s, y: el.y + u! * s + v! * c }));
}

function localDir(b: TrafficBuilding, dx: number, dy: number): { x: number; y: number } {
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

const last = <T>(list: readonly T[]): T => list[list.length - 1]!;


/** Spacing of the poses on a settling leg. */
const SETTLE_STEP = m(0.2);

/** A short leg from a pose to another, driven forward or backing */
function settle(from: AxlePose, to: AxlePose, reverse: boolean): Waypoint[] {
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
