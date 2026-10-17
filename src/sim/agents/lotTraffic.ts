import { m } from '@world/units';
import type { BuildingId } from '@world/buildings/types';
import { Heap } from '@core/heap';
import { WeightedSlots } from '@core/weightedSlots';
import { DRIVER_NOISE, DT, JAM_GAP } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { bodyClassOfArchetype } from '../vehicles/archetypes';
import { createVehicle, snapshot, type Vehicle, type VehicleId } from '../vehicles/state';
import { assignOccupancy } from '../vehicles/kerbStops';
import { planFrom } from '../routing/router';
import { chooseVehicleDestination } from '../routing/destination';
import { bayChangesSince, baySources, baysOfSource, stallFits, type Bay } from './parking';
import { trafficTarget } from '../vehicles/spawn';
import { flows, kindOf, type Mix } from '../ambient/demand';
import { buildingsChangedSince, spotKey } from '../ambient/ambientIndex';
import type { AmbientWorld } from '../ambient/ambient';
import { arrival, departure, type Manoeuvre } from './manoeuvre';
import { LorryTraffic } from './lorryTraffic';

/** Cars that use the lots' car gates */

/** Seconds between two looks for a car to send in. */
const LOOK = 1;
/** Fewest cars on their way in at once, and the seconds a car called takes to reach its lot, about (more traffic, more on their way). */
const MAX_COMING = 6;
const COMING_SECONDS = 60;
/** Mean seconds a car drives between two lots: one trip in this many ends in a lot each second. */
const TRIP_SECONDS = 180;
/** Most cars sent out of the lots in one look. */
const DEPART_PER_LOOK = 3;
/** Seconds a car stays parked: the stop's `duration`. */
const STAY_MIN = 40;
const STAY_MAX = 150;
/** Farthest a passing car is called from to a bay, and how long it has to get there. */
const CALL_REACH = m(320);
const CALL_TIMEOUT = 150;
/** How close to the lane a car leaving pulls up before looking for a gap; the room the traffic must leave it. */
const LANE_EDGE = m(4.5);
const GAP_BEHIND = m(30);
const GAP_AHEAD = m(10);
/** Speed a car joins the lane at. */
const JOIN_SPEED = m(2.4);
/** Seconds a car off the road waits for people on its way before going on (they walk out of a car's ground, `walk.ts`). */
const ASK_WAY = 3;
/** The kinds of car that park in lots. */
const PARKING_KINDS = new Set(['hatch', 'sedan', 'suv', 'van']);
/** The kinds of place a bay's building is (`ambient/demand.ts` kindOf), each a class of the draws; the last class, a building gone (weighs nought). */
const KINDS: readonly (keyof Mix)[] = ['home', 'shop', 'work', 'civic'];
const GONE = KINDS.length;
const CLASSES = KINDS.length + 1;

type Phase = 'coming' | 'parking' | 'parked' | 'leaving';

interface LotCar {
  readonly id: VehicleId;
  bay: Bay;
  phase: Phase;
  /** The car as drawn off the road; null while it drives in the traffic. */
  body: Vehicle | null;
  path: Manoeuvre | null;
  /** Seconds in the phase. */
  t: number;
  /** The lots' time (`LotTraffic.time`) its least stay parked is over at. */
  until: number;
  /** Sent out (`depart`): it leaves once its stay is over. */
  go: boolean;
  /** Seconds waited for people on the way. */
  waited: number;
  /** Holding the ground of the rest of its way: it drives on without stopping for anybody. */
  reserved: boolean;
  /** Its place in the lots' order (`track`), and its slot among the cars `depart` may draw (`waiting`). */
  readonly order: number;
  slot: number;
  /** Parked, its least stay over and not sent out (`ripen`): drawn by its bay's building's class. */
  ripe: boolean;
  kind: number;
  /** Where its bay is and where its body stands (`spotKey`): neither place a free bay. */
  readonly bayAt: number;
  bodyAt: number | null;
}

/** A gated bay as the lots keep it: its place, its slot in the bays' order, its building's class. */
interface GatedBay {
  bay: Bay;
  readonly key: number;
  slot: number;
  kind: number;
}

export class LotTraffic {
  private readonly cars = new Map<VehicleId, LotCar>();
  private nextOrder = 0;
  private clock = 0;
  /** The bays' diary as last read (`bayChangesSince`), and the serial seen a look before it was read. */
  private baysRead = -1;
  private baysSeen = -1;
  /** The gated bays by their source (`L<building>`, `K<segment>`), and by place (`spotKey`) in the order they were filed: kept from the diary. */
  private readonly bySource = new Map<string, Bay[]>();
  private readonly bays = new Map<number, GatedBay>();
  /** The gated bays by building: those whose class a building's change reaches (`followBuildings`). */
  private readonly baysOf = new Map<number, Set<GatedBay>>();
  /** DO NOT walk every gated bay a look with a text key each: each bay's slot in the bays' order, of its building's class while it is free (`free`) or holds a scenery's car (`scenery`) */
  private readonly free = new WeightedSlots(CLASSES);
  private readonly scenery = new WeightedSlots(CLASSES);
  private readonly bySlot: (GatedBay | undefined)[] = [];
  /** The cars of the lots by the place of their bay, how many of their bodies stand at each place, the places the lorries stand at during a look. */
  private readonly carsAt = new Map<number, LotCar[]>();
  private readonly bodies = new Map<number, number>();
  private readonly lorriesAt = new Set<number>();
  /** The cars of the lots in their order, each of its class while it is ripe: those `depart` draws among. */
  private readonly waiting = new WeightedSlots(CLASSES);
  private readonly carBySlot: (LotCar | undefined)[] = [];
  /** The parked cars' ids by when their least stay is over (`ripen`). */
  private readonly stays = new Heap();
  /** The buildings' diary as last read (`followBuildings`). */
  private buildingsSeen = -1;
  /** The draws' weights by class, filled for each draw. */
  private readonly weights = new Float64Array(CLASSES);
  /** The scenery the bays ask who stands in them; it tells each change of a bay of its (`AmbientWorld.sceneryWatch`). */
  private ambient: AmbientWorld | null = null;
  private readonly sceneryMoved = (spot: number): void => this.refresh(spot);
  /** The lorries to the works' docks, stepped with the cars (`lorryTraffic.ts`). */
  readonly lorries = new LorryTraffic();
  /** Counters for probes: cars sent in, parked, driven out. */
  called = 0;
  parkedIn = 0;
  leftBy = 0;

  /** DO NOT step every car of the lots a tick: those parked and not sent out stand still and are left out until `depart` sends them. */
  private readonly active = new Set<LotCar>();
  /** Seconds the lots have run: what a parked car's least stay is counted against (`LotCar.until`). */
  private time = 0;
  /** The cars on their way, and those driving into or out of a bay, in all and by building: kept by each change of phase (`enter`, `track`, `untrack`). */
  private comingCount = 0;
  private movingCount = 0;
  private readonly movingIn = new Map<number, number>();

  /** Cars driving off the road, into a bay or out of one: off the lanes */
  moving(): number {
    return this.lorries.moving() + this.movingCount;
  }

  /** A car taken into the lots' list, in its phase: its bay's place held, and its body's. */
  private track(id: VehicleId, bay: Bay, phase: Phase, body: Vehicle | null, go: boolean): void {
    const car: LotCar = {
      id, bay, phase, body, path: null, t: 0, until: 0, go, waited: 0, reserved: false,
      order: this.nextOrder++, slot: this.waiting.push(-1), ripe: false, kind: GONE, bayAt: spotKey(bay.x, bay.y), bodyAt: null,
    };
    this.carBySlot[car.slot] = car;
    this.cars.set(car.id, car);
    this.active.add(car);
    this.count(car, 1);
    const at = this.carsAt.get(car.bayAt);
    if (at) at.push(car); else this.carsAt.set(car.bayAt, [car]);
    this.refresh(car.bayAt);
    if (body) this.placeBody(car);
  }

  /** A car taken out of the lots' list: its places let go. */
  private untrack(car: LotCar): void {
    if (this.cars.get(car.id) !== car) return;
    this.cars.delete(car.id);
    this.active.delete(car);
    this.count(car, -1);
    const at = this.carsAt.get(car.bayAt)!;
    at.splice(at.indexOf(car), 1);
    if (!at.length) this.carsAt.delete(car.bayAt);
    this.refresh(car.bayAt);
    if (car.bodyAt !== null) { this.liftBody(car.bodyAt); car.bodyAt = null; }
    car.ripe = false;
    this.waiting.set(car.slot, -1);
    this.carBySlot[car.slot] = undefined;
    if (this.waiting.length > 2 * this.cars.size + 64) this.reslotCars();
  }

  private count(car: LotCar, by: 1 | -1): void {
    if (car.phase === 'coming') this.comingCount += by;
    else if (car.phase === 'parking' || car.phase === 'leaving') {
      this.movingCount += by;
      const n = (this.movingIn.get(car.bay.building) ?? 0) + by;
      if (n > 0) this.movingIn.set(car.bay.building, n); else this.movingIn.delete(car.bay.building);
    }
  }

  /** The cars of the lots, for probes: id, phase, the bay's building, where the body stands. */
  view(): { id: number; phase: Phase; building: number; x: number; y: number }[] {
    return [...this.cars.values()].map((c) => ({ id: c.id, phase: c.phase, building: c.bay.building, x: c.body?.free?.x ?? NaN, y: c.body?.free?.y ?? NaN }));
  }

  /** A different map (`AmbientWorld.reset`): the cars of the old one's lots are forgotten. */
  reset(w?: SimWorld): void {
    this.lorries.reset(w);
    this.cars.clear();
    this.nextOrder = 0;
    this.active.clear();
    this.time = 0;
    this.comingCount = 0;
    this.movingCount = 0;
    this.movingIn.clear();
    this.owed = 0;
    this.clock = 0;
    this.baysRead = -1;
    this.baysSeen = -1;
    this.dropEveryBay();
    this.carsAt.clear();
    this.bodies.clear();
    this.lorriesAt.clear();
    this.waiting.clear();
    this.carBySlot.length = 0;
    this.stays.clear();
    this.buildingsSeen = -1;
    // As a new map's: the counters from nought
    this.called = 0;
    this.parkedIn = 0;
    this.leftBy = 0;
  }

  /** Stage 2 (`sim/city/city.ts`): with the scenery on, cars go in and out of the lots. */
  step(w: SimWorld): void {
    if (!w.ambient.enabled) return;
    this.ambient = w.ambient;
    w.ambient.sceneryWatch = this.sceneryMoved;
    this.time += DT;
    for (const car of [...this.active]) {
      switch (car.phase) {
        case 'coming': this.coming(w, car); break;
        case 'parking': this.parking(w, car); break;
        case 'parked': this.parked(car); break;
        case 'leaving': this.leaving(w, car); break;
      }
      car.t += DT;
    }
    // The lorries, one in a yard at a time, and never while the lot's own cars are moving there.
    this.lorries.step(w, (building) => this.carsMoving(building));
    this.clock += DT;
    if (this.clock < LOOK) return;
    this.clock = 0;
    this.readBays(w);
    if (!this.bays.size) return;
    this.followBuildings(w);
    const target = trafficTarget(w);
    this.depart(w, target);
    // Trips ending in a lot, at the rate a trip ends; never more owed than can be on their way at once.
    let coming = this.comingCount;
    // As many on their way as the rate brings in over the minute or so a car takes to reach its lot.
    const most = Math.max(MAX_COMING, Math.ceil((target * COMING_SECONDS) / TRIP_SECONDS));
    this.owed = Math.min(most, this.owed + (target / TRIP_SECONDS) * LOOK);
    this.holdLorries(true);
    while (this.owed >= 1 && coming < most && this.call(w)) { this.owed--; coming++; }
    this.holdLorries(false);
  }

  /** Whether a lot's cars are driving in or out of it now. */
  private carsMoving(building: number): boolean {
    return this.movingIn.has(building);
  }

  /** Trips owed to the lots (`TRIP_SECONDS`), fractions carried from look to look. */
  private owed = 0;

  /** The hour of the city's day, for the lots' tables (`ambient/demand.ts`). */
  private hour(w: SimWorld): number {
    return (w.city.minutes(w) % 1440) / 60;
  }

  /** DO NOT build a pool of every ripe car and scenery's car a look: drawn by their running weights, the lots' cars in their order first, then the scenery's in the bays' order */
  private depart(w: SimWorld, target: number): void {
    // The cars driving in and out of the bays are driving too (`moving`), and those sent out will be
    // A car sent out stays stepped (`active`) until it is on the lane again.
    let leaving = this.movingCount;
    for (const car of this.active) if (car.phase === 'parked' && car.go) leaving++;
    const short = Math.min(DEPART_PER_LOOK, target - w.vehicles.size - leaving);
    if (short <= 0) return;
    this.ripen(w);
    const weights = this.weights, hour = this.hour(w);
    KINDS.forEach((kind, k) => { weights[k] = flows(kind, hour).out; });
    weights[GONE] = 0;
    for (let k = 0; k < short && this.waiting.total() + this.scenery.total() > 0; k++) {
      const cars = weightOf(this.waiting, weights);
      const total = cars + weightOf(this.scenery, weights);
      if (total <= 0) return;
      const roll = w.rng.lots.float() * total;
      const slot = this.waiting.findWeighted(weights, roll);
      let car = slot >= 0 ? this.carBySlot[slot]! : null;
      let bay: GatedBay | null = null;
      if (!car) {
        const at = this.scenery.findWeighted(weights, Math.max(0, roll - cars));
        if (at >= 0) bay = this.bySlot[at]!;
        // Past every running sum (the roll's rounding): the last of them, as a pool of them all kept it.
        else if (this.scenery.total()) bay = this.bySlot[this.scenery.nth(this.scenery.total() - 1)]!;
        else car = this.carBySlot[this.waiting.nth(this.waiting.total() - 1)]!;
      }
      if (car) {
        car.go = true;
        car.ripe = false;
        this.waiting.set(car.slot, -1);
        this.active.add(car);
        continue;
      }
      // The scenery's car: the lots' from now on, a vehicle made of its row, its bay left empty when the scenery makes its bays again.
      const body = w.ambient.release(w, w.ambient.sceneryCarAt(bay!.key)!);
      this.track(body.id, bay!.bay, 'parked', body, true);
      // Drawn with the cars standing in bays again, now as the lots' (`isParked`).
      w.ambient.addParked(body);
    }
  }

  /** The parked cars whose least stay is over drawn among (`waiting`) from now on, until sent out or gone. */
  private ripen(w: SimWorld): void {
    while (this.stays.size && this.stays.peekKey() <= this.time) {
      const car = this.cars.get(this.stays.pop());
      if (!car || car.ripe || car.phase !== 'parked' || car.go || !car.body || this.time < car.until) continue;
      car.ripe = true;
      this.rank(w, car);
    }
  }

  /** A ripe car's class: its bay's building's kind. */
  private rank(w: SimWorld, car: LotCar): void {
    car.kind = kindClass(w, car.bay.building);
    this.waiting.set(car.slot, car.kind);
  }

  /** DO NOT read the town's list (`collectBays`) on a change of `buildings.revision` */
  private readBays(w: SimWorld): void {
    const { serial, changed } = bayChangesSince(w, this.baysRead, this);
    if (changed !== null && changed.length === 0) { this.baysRead = serial; return; }
    if (serial !== this.baysSeen) { this.baysSeen = serial; return; }
    const sources = changed ?? baySources(w);
    const gone = new Set<number>();
    if (changed === null) {
      for (const key of this.bays.keys()) gone.add(key);
      this.dropEveryBay();
      // Each bay's building read as it is filed: the buildings' diary read up to now.
      this.buildingsSeen = w.doc.changes.version;
    }
    for (const source of new Set(sources)) {
      for (const bay of this.bySource.get(source) ?? []) {
        const key = spotKey(bay.x, bay.y);
        gone.add(key);
        this.dropBay(key);
      }
      const now = baysOfSource(w, source).filter((b) => !b.kerb && b.lane?.entryAt !== undefined && b.via.length > 0);
      if (now.length) this.bySource.set(source, now); else this.bySource.delete(source);
      for (const bay of now) this.fileBay(w, bay);
    }
    this.baysRead = serial;
    if (this.free.length > 2 * this.bays.size + 64) this.reslotBays();
    // A car whose bay went (its building was replaced) goes with it, unless it is on its way: in the lots' order.
    const hit: LotCar[] = [];
    for (const key of gone) for (const car of this.carsAt.get(key) ?? []) hit.push(car);
    hit.sort((a, b) => a.order - b.order);
    for (const car of hit) {
      if (this.cars.get(car.id) !== car) continue;
      const now = this.bays.get(car.bayAt);
      if (now) {
        this.count(car, -1);
        car.bay = now.bay;
        this.count(car, 1);
        if (car.ripe) this.rank(w, car);
        continue;
      }
      if (car.phase === 'coming') this.release(w, car);
      else if (car.phase === 'parked') this.drop(w, car);
    }
  }

  /** A gated bay filed at its place; a second bay at a place held takes it and keeps its slot, as the list of bays kept the place's turn. */
  private fileBay(w: SimWorld, bay: Bay): void {
    const key = spotKey(bay.x, bay.y);
    let e = this.bays.get(key);
    if (e) {
      this.leaveBuilding(e);
      e.bay = bay;
    } else {
      e = { bay, key, slot: this.free.push(-1), kind: GONE };
      this.scenery.push(-1);
      this.bySlot[e.slot] = e;
      this.bays.set(key, e);
    }
    e.kind = kindClass(w, bay.building);
    let list = this.baysOf.get(bay.building);
    if (!list) this.baysOf.set(bay.building, list = new Set());
    list.add(e);
    this.refreshBay(e);
  }

  private dropBay(key: number): void {
    const e = this.bays.get(key);
    if (!e) return;
    this.bays.delete(key);
    this.leaveBuilding(e);
    this.free.set(e.slot, -1);
    this.scenery.set(e.slot, -1);
    this.bySlot[e.slot] = undefined;
  }

  private leaveBuilding(e: GatedBay): void {
    const list = this.baysOf.get(e.bay.building);
    if (!list) return;
    list.delete(e);
    if (!list.size) this.baysOf.delete(e.bay.building);
  }

  /** @rebuild Every gated bay let go: the bays read whole again (a map loaded, the diary unable to say which changed). */
  private dropEveryBay(): void {
    this.bySource.clear();
    this.bays.clear();
    this.baysOf.clear();
    this.free.clear();
    this.scenery.clear();
    this.bySlot.length = 0;
  }

  /** The bays' slots handed out again in their order, those let go dropped (more of them than of bays now). */
  private reslotBays(): void {
    this.free.clear();
    this.scenery.clear();
    this.bySlot.length = 0;
    for (const e of this.bays.values()) {
      e.slot = this.free.push(-1);
      this.scenery.push(-1);
      this.bySlot[e.slot] = e;
      this.refreshBay(e);
    }
  }

  /** The cars' slots handed out again in the lots' order, those of cars gone dropped (more of them than of cars now). */
  private reslotCars(): void {
    this.waiting.clear();
    this.carBySlot.length = 0;
    for (const car of this.cars.values()) {
      car.slot = this.waiting.push(car.ripe ? car.kind : -1);
      this.carBySlot[car.slot] = car;
    }
  }

  /** The bays and ripe cars of the buildings the diary says changed: their class read again (a draw weighs a building's kind). */
  private followBuildings(w: SimWorld): void {
    const diary = w.doc.changes;
    if (this.buildingsSeen >= diary.version) return;
    const changed = buildingsChangedSince(diary, this.buildingsSeen);
    this.buildingsSeen = diary.version;
    if (changed === null) { this.rankEvery(w); return; }
    for (const id of changed) for (const e of this.baysOf.get(id) ?? []) this.rankBay(w, e);
  }

  private rankBay(w: SimWorld, e: GatedBay): void {
    const kind = kindClass(w, e.bay.building);
    if (kind !== e.kind) { e.kind = kind; this.refreshBay(e); }
    for (const car of this.carsAt.get(e.key) ?? []) if (car.ripe) this.rank(w, car);
  }

  /** @rebuild Every bay's and ripe car's class read again: the buildings' diary unable to say which changed. */
  private rankEvery(w: SimWorld): void {
    for (const e of this.bays.values()) this.rankBay(w, e);
    for (const car of this.cars.values()) if (car.ripe) this.rank(w, car);
  }

  /** A bay's place looked at again (`refreshBay`). */
  private refresh(key: number): void {
    const e = this.bays.get(key);
    if (e) this.refreshBay(e);
  }

  /** Free while no car of the lots holds it, no body of theirs or lorry stands on it and no scenery's car is in it; the scenery's while one is */
  private refreshBay(e: GatedBay): void {
    const standing = this.ambient?.sceneryCarAt(e.key) !== undefined;
    const free = !standing && !this.carsAt.has(e.key) && !this.bodies.has(e.key) && !this.lorriesAt.has(e.key);
    this.free.set(e.slot, free ? e.kind : -1);
    this.scenery.set(e.slot, standing ? e.kind : -1);
  }

  /** A car's body counted where it stands now, the bay there no longer free. */
  private placeBody(car: LotCar): void {
    const f = car.body!.free!;
    const key = spotKey(f.x, f.y);
    if (key === car.bodyAt) return;
    if (car.bodyAt !== null) this.liftBody(car.bodyAt);
    car.bodyAt = key;
    this.bodies.set(key, (this.bodies.get(key) ?? 0) + 1);
    this.refresh(key);
  }

  private liftBody(key: number): void {
    const n = (this.bodies.get(key) ?? 0) - 1;
    if (n > 0) this.bodies.set(key, n); else this.bodies.delete(key);
    this.refresh(key);
  }

  /** A car's body moved off the road, counted where it stands now. */
  private move(car: LotCar, p: { x: number; y: number; angle: number }): void {
    setFree(car.body!, p);
    this.placeBody(car);
  }

  /** The places the lorries' bodies stand at held through a look's calls (their bays not free), or let go. */
  private holdLorries(hold: boolean): void {
    if (hold) {
      for (const p of this.lorries.places()) {
        const key = spotKey(p.x, p.y);
        if (this.lorriesAt.has(key)) continue;
        this.lorriesAt.add(key);
        this.refresh(key);
      }
      return;
    }
    if (!this.lorriesAt.size) return;
    const keys = [...this.lorriesAt];
    this.lorriesAt.clear();
    for (const key of keys) this.refresh(key);
  }

  /** DO NOT draw among the bays near the view (`SimWorld.focus`); DO NOT list the free bays to draw one: their running weights by class */
  private call(w: SimWorld): boolean {
    const free = this.free;
    const n = free.total();
    if (!n) return false;
    const weights = this.weights, hour = this.hour(w);
    KINDS.forEach((kind, k) => { weights[k] = flows(kind, hour).in; });
    weights[GONE] = 0;
    const total = weightOf(free, weights);
    const roll = w.rng.lots.float() * total;
    let slot: number;
    if (total > 0) {
      slot = free.findWeighted(weights, roll);
      // Past every running sum (the roll's rounding): the last free bay.
      if (slot < 0) slot = free.nth(n - 1);
    } else slot = free.nth(Math.floor(w.rng.lots.float() * n));
    const bay = this.bySlot[slot]!.bay;
    const lane = bay.lane!;
    const stopAt = lane.entryAt ?? lane.at;
    let best: Vehicle | null = null, bestD = CALL_REACH;
    // DO NOT walk the fleet for it: the cars on the lanes within reach (`vehiclesNear`).
    for (const v of w.vehiclesNear(lane.x, lane.y, CALL_REACH)) {
      if (this.cars.has(v.id) || v.commute || v.kerbStop || v.errand || !PARKING_KINDS.has(v.archetype.id)) continue;
      // Only a body the stall holds whole (`stallFits`).
      if (!stallFits(bay, v.archetype.length)) continue;
      // Already past the gate on its lane: it would have to go round the block.
      if (v.lanelet === lane.lanelet && v.s > stopAt - m(8)) continue;
      const pose = vehiclePose(w, v, 1);
      if (!pose) continue;
      const d = Math.hypot(pose.p.x - lane.x, pose.p.y - lane.y);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) return false;
    const v = best;
    const was = v.destination;
    v.commute = { trip: -2, lanelet: lane.lanelet, at: stopAt + v.archetype.length / 2 };
    v.destination = lane.lanelet;
    planFrom(w, v);
    if (v.destination !== lane.lanelet) {
      // No way there from where it is: it goes on where it was going.
      v.commute = null;
      v.destination = was;
      planFrom(w, v);
      return false;
    }
    this.track(v.id, bay, 'coming', null, false);
    this.called++;
    return true;
  }

  // ------------------------------------------------------------ the phases

  private coming(w: SimWorld, car: LotCar): void {
    const v = w.vehicles.get(car.id);
    if (!v) { this.untrack(car); return; }
    const c = v.commute;
    if (!c || car.t > CALL_TIMEOUT || (v.destination !== c.lanelet && v.lanelet !== c.lanelet)) { this.release(w, car); return; }
    // Stopped before the gate (or just past it: a lane change can carry it on, and the stop then holds it there).
    if (v.lanelet !== c.lanelet || v.v > m(0.12) || v.s < c.at - m(2.5)) return;
    const pose = vehiclePose(w, v, 1);
    if (!pose) { this.release(w, car); return; }
    w.removeVehicle(v);
    const body = offRoad(w, v, pose.p.x, pose.p.y, pose.angle, car.bay.building);
    body.seats = 1;
    car.body = body;
    this.placeBody(car);
    // DO NOT ask every car of the lots each tick: drawn with the cars standing in bays as it comes off the road (`isParked`).
    w.ambient.addParked(body);
    car.path = arrival({ x: pose.p.x, y: pose.p.y, angle: pose.angle }, car.bay);
    this.enter(car, 'parking');
  }

  private parking(w: SimWorld, car: LotCar): void {
    const body = car.body!, path = car.path!;
    if (!this.mayGo(w, car, body)) { body.v = 0; this.move(car, path.poseAt()); return; }
    const v = path.speed();
    path.advance(v * DT);
    body.s = path.s;
    body.v = path.done ? 0 : v;
    this.move(car, path.poseAt());
    if (!path.done) return;
    body.seats = 0;
    car.path = null;
    car.until = this.time + STAY_MIN + w.rng.lots.float() * (STAY_MAX - STAY_MIN);
    this.parkedIn++;
    this.enter(car, 'parked');
    // Drawn among those `depart` may send out once its least stay is over (`ripen`).
    this.stays.push(car.id, car.until);
  }

  private parked(car: LotCar): void {
    const body = car.body!;
    const f = body.free!;
    body.v = 0;
    this.move(car, { x: f.x, y: f.y, angle: f.angle });
    // Standing, and not sent out: still from now on, left out of the steps until `depart` sends it.
    if (!car.go) { this.active.delete(car); return; }
    // Out only when sent (`depart`: fewer cars drive than the panel asks for), its least stay over.
    if (this.time < car.until || !car.bay.lane) return;
    body.seats = 1;
    car.path = departure(car.bay, car.bay.lane);
    this.enter(car, 'leaving');
  }

  private leaving(w: SimWorld, car: LotCar): void {
    const body = car.body!, path = car.path!;
    const lane = car.bay.lane!;
    const atKerb = path.length - path.s <= LANE_EDGE;
    if (!this.mayGo(w, car, body) || (atKerb && !this.gap(w, body, lane))) { body.v = 0; this.move(car, path.poseAt()); return; }
    const v = path.speed();
    path.advance(v * DT);
    body.s = path.s;
    body.v = v;
    this.move(car, path.poseAt());
    if (!path.done) return;
    // On the lane: the same car is a vehicle of the traffic again, bound for a road end.
    this.drop(w, car);
    const l = w.lanelet(lane.lanelet);
    if (!l) return;
    const a = body.archetype;
    const id = w.vehicles.has(car.id) ? (w.nextVehicleId++ as VehicleId) : car.id;
    const v0 = l.speedLimit * a.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi);
    const road = createVehicle(id, a, body.driver, body.color, l.id, v0, w.clock.tick);
    road.s = Math.min(l.length, lane.at + a.length / 2);
    road.v = JOIN_SPEED;
    road.prev = snapshot(road);
    // Who rides with the driver, and whether the trip has somebody to drop or pick up on the way
    assignOccupancy(w, road);
    w.vehicles.set(road.id, road);
    w.enterLanelet(road, l.id);
    road.destination = chooseVehicleDestination(w, l.id, bodyClassOfArchetype(a));
    planFrom(w, road);
    this.leftBy++;
  }

  // ------------------------------------------------------------ helpers

  private enter(car: LotCar, phase: Phase): void {
    this.count(car, -1);
    car.phase = phase;
    this.count(car, 1);
    car.t = 0;
    car.waited = 0;
    car.reserved = false;
  }

  /** A car sent to a bay that will not reach it: on to a road end like the rest. */
  private release(w: SimWorld, car: LotCar): void {
    this.untrack(car);
    const v = w.vehicles.get(car.id);
    if (!v) return;
    v.commute = null;
    v.destination = chooseVehicleDestination(w, v.lanelet, bodyClassOfArchetype(v.archetype));
    planFrom(w, v);
  }

  /** A car off the road taken out of the lots' list and of the drawn ones. */
  private drop(w: SimWorld, car: LotCar): void {
    this.untrack(car);
    if (car.body) w.ambient.removeParked(car.body);
  }

  /** Whether nobody stands where the car will go over the rest of its way (its body as three discs every metre) */
  private mayGo(w: SimWorld, car: LotCar, body: Vehicle): boolean {
    // A lorry shunting in the yard: the cars of its lot wait (`lorryTraffic.ts`).
    if (!car.reserved && this.lorries.busy(car.bay.building)) return false;
    if (car.reserved) return true;
    const path = car.path!;
    const a = body.archetype;
    const reach = Math.max(0, a.length / 2 - a.width / 2);
    const r = a.width / 2 + m(0.4);
    const discs: { x: number; y: number }[] = [];
    for (let s = path.s; ; s = Math.min(path.length, s + m(1))) {
      const q = path.poseAt(s);
      const cx = Math.cos(q.angle) * reach, cy = Math.sin(q.angle) * reach;
      for (const j of [-1, 0, 1]) discs.push({ x: q.x + cx * j, y: q.y + cy * j });
      if (s >= path.length) break;
    }
    // DO NOT walk `w.pedViews`: every person of the map, for each car off the road, every tick.
    let clear = true;
    const people = w.pedEngine.bridge;
    for (const d of discs) if (people.anyoneWithin(w, d.x, d.y, r, null)) { clear = false; break; }
    if (clear || car.waited >= ASK_WAY) { car.reserved = true; return true; }
    car.waited += DT;
    return false;
  }

  /** Room in the traffic for a car joining the lane at its joining point. */
  private gap(w: SimWorld, body: Vehicle, lane: NonNullable<Bay['lane']>): boolean {
    const len = body.archetype.length;
    const front = lane.at + len / 2;
    for (const other of w.bodiesIn(lane.lanelet)) {
      const rear = other.s - other.vehicle.archetype.length;
      if (other.s > front - len - GAP_BEHIND - JAM_GAP && rear < front + GAP_AHEAD) return false;
    }
    return true;
  }
}

/** A building's class in the draws: its kind of place (`KINDS`), or `GONE`. */
function kindClass(w: SimWorld, building: BuildingId): number {
  const b = w.buildings.get(building);
  return b ? KINDS.indexOf(kindOf(b)) : GONE;
}

/** A list's whole weight: each class's count by its weight. */
function weightOf(slots: WeightedSlots, weights: ArrayLike<number>): number {
  let sum = 0;
  for (let c = 0; c < CLASSES; c++) sum += weights[c]! * slots.count(c);
  return sum;
}

/** The car as a drawn body off the road, standing at `(x, y)` facing `angle`. */
function offRoad(w: SimWorld, v: Vehicle, x: number, y: number, angle: number, lot: number): Vehicle {
  const body = createVehicle(v.id, v.archetype, v.driver, v.color, v.lanelet, 0, w.clock.tick);
  body.seats = 0;
  body.free = { x, y, angle, px: x, py: y, pangle: angle, lot };
  return body;
}

function setFree(body: Vehicle, p: { x: number; y: number; angle: number }): void {
  const f = body.free!;
  f.px = f.x; f.py = f.y; f.pangle = f.angle;
  f.x = p.x; f.y = p.y; f.angle = p.angle;
}
