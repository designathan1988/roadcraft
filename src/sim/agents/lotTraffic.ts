import { m, stepsIn } from '@world/units';
import { DRIVER_NOISE, DT, JAM_GAP } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { bodyClassOfArchetype } from '../vehicles/archetypes';
import { createVehicle, snapshot, type Vehicle, type VehicleId } from '../vehicles/state';
import { assignOccupancy } from '../vehicles/kerbStops';
import { planFrom } from '../routing/router';
import { chooseVehicleDestination } from '../routing/destination';
import { collectBays, stallFits, type Bay } from './parking';
import { trafficTarget } from '../vehicles/spawn';
import { flows, kindOf } from '../ambient/demand';
import { arrival, departure, type Manoeuvre } from './manoeuvre';
import { LorryTraffic } from './lorryTraffic';

/**
 * Cars that use the lots' car gates: in from the street, through the gate,
 * up the drive to a stall of the car park behind, a while parked, and out
 * through the same gate onto the street again.
 *
 * A lot's car park is a SUMO parking area: bound to the lane its access is on
 * (here the lane in front of the car gate, `parking.ts` `gateExits`), reached
 * by a stop on that lane, held for a `duration`, and left onto the lane at a
 * `departPos` of its own, a few metres past the gate. A car of the passing
 * traffic is given that stop: it pulls up a few metres before the gate
 * (`BayLane.entryAt`), leaves the lane and is driven off the road
 * (`manoeuvre.ts`) through the gate to the stall; parked, it is one of the
 * cars standing in bays (`AmbientWorld.parked`, which the renderer draws and
 * walkers keep off); leaving, it backs out, drives out of the gate, waits at
 * the kerb for a gap and joins the traffic again, bound for a road end like
 * any other car.
 *
 * THE LOTS MAKE THE TRIPS, as the buildings of Cities: Skylines send their
 * cars out and take them in: a car of the traffic ends its trip in a lot at
 * the rate a trip ends (`TRIP_SECONDS`), to a lot drawn by how many go in
 * at its kind of place at this hour (`ambient/demand.ts` flows); and while
 * fewer cars drive than the panel asks for (`trafficTarget`), cars standing
 * in the lots' bays - the scenery's, handed over (`AmbientWorld.release`),
 * or those parked here - drive out, drawn by how many come out of each kind
 * of place now. A town with no road leading off the map keeps its traffic
 * this way; the road ends bring theirs in and take it away as before.
 * Where the camera is plays no part (the same map runs the same with the
 * camera anywhere).
 */

/** Seconds between two looks for a car to send in. */
const LOOK = 1;
/** Fewest cars on their way in at once, and the seconds a car called takes to reach its lot, about (more traffic, more on their way). */
const MAX_COMING = 6;
const COMING_SECONDS = 60;
/**
 * Mean seconds a car drives between two lots: one trip in this many ends in
 * a lot each second. Three minutes of play is an hour of the city's day
 * (`city.ts` TIME_SCALE 20): long enough that a car is seen driving a
 * while, short enough that the lots are seen working within a minute.
 */
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
  /** Seconds it stays parked at least. */
  stay: number;
  /** Sent out (`depart`): it leaves once its stay is over. */
  go: boolean;
  /** Seconds waited for people on the way. */
  waited: number;
  /** Holding the ground of the rest of its way: it drives on without stopping for anybody. */
  reserved: boolean;
}

const bayKey = (b: { x: number; y: number }): string => `${Math.round(stepsIn(b.x, 0.1))},${Math.round(stepsIn(b.y, 0.1))}`;

export class LotTraffic {
  private readonly cars = new Map<VehicleId, LotCar>();
  private clock = 0;
  private baysFor = '';
  private seenFor = '';
  private bays: Bay[] = [];
  /** The lorries to the works' docks, stepped with the cars (`lorryTraffic.ts`). */
  readonly lorries = new LorryTraffic();
  /** Counters for probes: cars sent in, parked, driven out. */
  called = 0;
  parkedIn = 0;
  leftBy = 0;

  /**
   * Cars driving off the road, into a bay or out of one: off the lanes (not
   * in `SimWorld.vehicles`) but moving in sight, so the panel counts them
   * among the cars driving (`main.ts` updateStatus).
   */
  moving(): number {
    let n = this.lorries.moving();
    for (const car of this.cars.values()) if (car.phase === 'parking' || car.phase === 'leaving') n++;
    return n;
  }

  /** The cars of the lots, for probes: id, phase, the bay's building, where the body stands. */
  view(): { id: number; phase: Phase; building: number; x: number; y: number }[] {
    return [...this.cars.values()].map((c) => ({ id: c.id, phase: c.phase, building: c.bay.building, x: c.body?.free?.x ?? NaN, y: c.body?.free?.y ?? NaN }));
  }

  /**
   * A different map (`AmbientWorld.reset`): the cars of the old one's lots
   * are forgotten. Kept, those parking or driving out of a lot were drawn on
   * the new map where the old lot had been.
   */
  reset(w?: SimWorld): void {
    this.lorries.reset(w);
    this.cars.clear();
    this.owed = 0;
    this.clock = 0;
    this.baysFor = '';
    this.seenFor = '';
    this.bays = [];
    // As a new map's: the counters from nought (the random stream is the
    // world's, `SimWorld.rng.lots`, forked again by `SimWorld.reset`).
    this.called = 0;
    this.parkedIn = 0;
    this.leftBy = 0;
  }

  /** Stage 2 (`sim/city/city.ts`): with the scenery on, cars go in and out of the lots. */
  step(w: SimWorld): void {
    if (!w.ambient.enabled) return;
    for (const car of [...this.cars.values()]) {
      switch (car.phase) {
        case 'coming': this.coming(w, car); break;
        case 'parking': this.parking(w, car); break;
        case 'parked': this.parked(car); break;
        case 'leaving': this.leaving(w, car); break;
      }
      car.t += DT;
    }
    // Drawn with the cars standing in bays: the scenery makes that list again
    // when the bays change, keeping these. DO NOT ask `parked.includes` here:
    // that walked every parked car of the map for each car of the lots, each tick.
    for (const car of this.cars.values()) if (car.body && !w.ambient.isParked(car.body)) w.ambient.addParked(car.body);
    // The lorries, one in a yard at a time, and never while the lot's own cars are moving there.
    this.lorries.step(w, (building) => this.carsMoving(building));
    this.clock += DT;
    if (this.clock < LOOK) return;
    this.clock = 0;
    this.readBays(w);
    if (!this.bays.length) return;
    const target = trafficTarget(w);
    this.depart(w, target);
    // Trips ending in a lot, at the rate a trip ends; never more owed than can be on their way at once.
    let coming = 0;
    for (const car of this.cars.values()) if (car.phase === 'coming') coming++;
    // As many on their way as the rate brings in over the minute or so a car takes to reach its lot.
    const most = Math.max(MAX_COMING, Math.ceil((target * COMING_SECONDS) / TRIP_SECONDS));
    this.owed = Math.min(most, this.owed + (target / TRIP_SECONDS) * LOOK);
    while (this.owed >= 1 && coming < most && this.call(w)) { this.owed--; coming++; }
  }

  /** Whether a lot's cars are driving in or out of it now. */
  private carsMoving(building: number): boolean {
    for (const car of this.cars.values()) if (car.bay.building === building && (car.phase === 'parking' || car.phase === 'leaving')) return true;
    return false;
  }

  /** Trips owed to the lots (`TRIP_SECONDS`), fractions carried from look to look. */
  private owed = 0;

  /** The hour of the city's day, for the lots' tables (`ambient/demand.ts`). */
  private hour(w: SimWorld): number {
    return (w.city.minutes(w) % 1440) / 60;
  }

  /**
   * While fewer cars drive than the panel asks for, cars standing in the lots'
   * bays drive out (a few a look): a lot drawn by how many come out of its
   * kind of place at this hour. Those parked here go once their stay is over;
   * one of the scenery's standing in a gated bay is handed over and goes now.
   */
  private depart(w: SimWorld, target: number): void {
    // The cars driving in and out of the bays are driving too (`moving`), and
    // those sent out will be: the panel's number is the lanes' and theirs.
    let leaving = 0;
    for (const car of this.cars.values()) if (car.phase === 'parking' || car.phase === 'leaving' || car.go) leaving++;
    const short = Math.min(DEPART_PER_LOOK, target - w.vehicles.size - leaving);
    if (short <= 0) return;
    const hour = this.hour(w);
    const outOf = new Map<number, number>();
    const weight = (bay: Bay): number => {
      let f = outOf.get(bay.building);
      if (f === undefined) {
        const b = w.doc.buildings.get(bay.building);
        outOf.set(bay.building, f = b ? flows(kindOf(b), hour).out : 0);
      }
      return f;
    };
    const pool: { bay: Bay; car: LotCar | null; body: Vehicle; weight: number }[] = [];
    for (const car of this.cars.values()) {
      if (car.phase === 'parked' && !car.go && car.stay <= 0 && car.body) pool.push({ bay: car.bay, car, body: car.body, weight: weight(car.bay) });
    }
    for (const { bay, body } of this.sceneryInBays(w)) pool.push({ bay, car: null, body, weight: weight(bay) });
    for (let k = 0; k < short && pool.length; k++) {
      let total = 0;
      for (const p of pool) total += p.weight;
      if (total <= 0) return;
      let roll = w.rng.lots.float() * total, at = pool.length - 1;
      for (let i = 0; i < pool.length; i++) { roll -= pool[i]!.weight; if (roll < 0) { at = i; break; } }
      const pick = pool.splice(at, 1)[0]!;
      if (pick.car) { pick.car.go = true; continue; }
      // The scenery's car: the lots' from now on, its bay left empty when the scenery makes its bays again.
      w.ambient.release(pick.body);
      this.cars.set(pick.body.id, { id: pick.body.id, bay: pick.bay, phase: 'parked', body: pick.body, path: null, t: 0, stay: 0, go: true, waited: 0, reserved: false });
    }
  }

  /** The gated lots' bays, read again a look after the buildings or the roads changed (the scenery fills them first). */
  private readBays(w: SimWorld): void {
    const key = `${w.doc.buildings.revision}:${w.topologyRevision}`;
    if (key !== this.seenFor) { this.seenFor = key; return; }
    if (key === this.baysFor) return;
    this.baysFor = key;
    this.bays = collectBays(w).filter((b) => !b.kerb && b.lane?.entryAt !== undefined && b.via.length > 0);
    const live = new Map(this.bays.map((b) => [bayKey(b), b]));
    // A car whose bay is gone (its building was replaced) goes with it, unless it is on its way.
    for (const car of [...this.cars.values()]) {
      const now = live.get(bayKey(car.bay));
      if (now) { car.bay = now; continue; }
      if (car.phase === 'coming') this.release(w, car);
      else if (car.phase === 'parked') this.drop(w, car);
    }
  }

  /**
   * A free bay, drawn by how many go in at its kind of place at this hour,
   * and the nearest passing car sent to it. False when none was. DO NOT
   * draw among the bays near the view (`SimWorld.focus`): the camera is no
   * input of the simulation, and the same map ran otherwise with the camera
   * elsewhere.
   */
  private call(w: SimWorld): boolean {
    const free = this.freeBays(w);
    if (!free.length) return false;
    const pool = free;
    const hour = this.hour(w);
    const into = new Map<number, number>();
    const weights = pool.map((bay) => {
      let f = into.get(bay.building);
      if (f === undefined) {
        const b = w.doc.buildings.get(bay.building);
        into.set(bay.building, f = b ? flows(kindOf(b), hour).in : 0);
      }
      return f;
    });
    let total = 0;
    for (const x of weights) total += x;
    let roll = w.rng.lots.float() * total, at = pool.length - 1;
    if (total > 0) for (let i = 0; i < pool.length; i++) { roll -= weights[i]!; if (roll < 0) { at = i; break; } }
    else at = Math.floor(w.rng.lots.float() * pool.length);
    const bay = pool[at]!;
    const lane = bay.lane!;
    const stopAt = lane.entryAt ?? lane.at;
    let best: Vehicle | null = null, bestD = CALL_REACH;
    for (const v of w.vehicles.values()) {
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
    this.cars.set(v.id, { id: v.id, bay, phase: 'coming', body: null, path: null, t: 0, stay: 0, go: false, waited: 0, reserved: false });
    this.called++;
    return true;
  }

  /**
   * The scenery's cars standing in the gated bays, by the bay
   * (`AmbientWorld.sceneryCarAt`), in the order of the bays - the order the
   * scenery stood them in. DO NOT walk `ambient.parked` for them: every
   * parked car of the map, each look.
   */
  private sceneryInBays(w: SimWorld): { bay: Bay; body: Vehicle }[] {
    const out: { bay: Bay; body: Vehicle }[] = [];
    const pooled = new Set<Vehicle>();
    for (const bay of this.bays) {
      const body = w.ambient.sceneryCarAt(bayKey(bay));
      if (!body || this.cars.has(body.id) || pooled.has(body)) continue;
      pooled.add(body);
      out.push({ bay, body });
    }
    return out;
  }

  /**
   * The gated bays nobody stands in nor is on the way to: not where a car of
   * the lots is bound or stands, nor where a lorry's body is, nor one the
   * scenery has a car in (asked of the scenery by place). DO NOT walk
   * `ambient.parked` for it: every parked car of the map, each call.
   */
  private freeBays(w: SimWorld): Bay[] {
    const taken = new Set<string>();
    for (const car of this.cars.values()) {
      taken.add(bayKey(car.bay));
      if (car.body?.free) taken.add(bayKey(car.body.free));
    }
    for (const lorry of this.lorries.view()) if (Number.isFinite(lorry.x)) taken.add(bayKey(lorry));
    return this.bays.filter((b) => !taken.has(bayKey(b)) && !w.ambient.sceneryCarAt(bayKey(b)));
  }

  // ------------------------------------------------------------ the phases

  private coming(w: SimWorld, car: LotCar): void {
    const v = w.vehicles.get(car.id);
    if (!v) { this.cars.delete(car.id); return; }
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
    car.path = arrival({ x: pose.p.x, y: pose.p.y, angle: pose.angle }, car.bay);
    this.enter(car, 'parking');
  }

  private parking(w: SimWorld, car: LotCar): void {
    const body = car.body!, path = car.path!;
    if (!this.mayGo(w, car, body)) { body.v = 0; setFree(body, path.poseAt()); return; }
    const v = path.speed();
    path.advance(v * DT);
    body.s = path.s;
    body.v = path.done ? 0 : v;
    setFree(body, path.poseAt());
    if (!path.done) return;
    body.seats = 0;
    car.path = null;
    car.stay = STAY_MIN + w.rng.lots.float() * (STAY_MAX - STAY_MIN);
    this.parkedIn++;
    this.enter(car, 'parked');
  }

  private parked(car: LotCar): void {
    const body = car.body!;
    const f = body.free!;
    body.v = 0;
    setFree(body, { x: f.x, y: f.y, angle: f.angle });
    car.stay -= DT;
    // Out only when sent (`depart`: fewer cars drive than the panel asks for), its least stay over.
    if (car.stay > 0 || !car.go || !car.bay.lane) return;
    body.seats = 1;
    car.path = departure(car.bay, car.bay.lane);
    this.enter(car, 'leaving');
  }

  private leaving(w: SimWorld, car: LotCar): void {
    const body = car.body!, path = car.path!;
    const lane = car.bay.lane!;
    const atKerb = path.length - path.s <= LANE_EDGE;
    if (!this.mayGo(w, car, body) || (atKerb && !this.gap(w, body, lane))) { body.v = 0; setFree(body, path.poseAt()); return; }
    const v = path.speed();
    path.advance(v * DT);
    body.s = path.s;
    body.v = v;
    setFree(body, path.poseAt());
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
    // Who rides with the driver, and whether the trip has somebody to drop or
    // pick up on the way, as every other car out on the road (`spawn.ts`).
    // With the driver alone, a town with no road off the map - its cars all
    // out of the lots - never had a passenger nor a stop at the kerb.
    assignOccupancy(w, road);
    w.vehicles.set(road.id, road);
    w.enterLanelet(road, l.id);
    road.destination = chooseVehicleDestination(w, l.id, bodyClassOfArchetype(a));
    planFrom(w, road);
    this.leftBy++;
  }

  // ------------------------------------------------------------ helpers

  private enter(car: LotCar, phase: Phase): void {
    car.phase = phase;
    car.t = 0;
    car.waited = 0;
    car.reserved = false;
  }

  /** A car sent to a bay that will not reach it: on to a road end like the rest. */
  private release(w: SimWorld, car: LotCar): void {
    this.cars.delete(car.id);
    const v = w.vehicles.get(car.id);
    if (!v) return;
    v.commute = null;
    v.destination = chooseVehicleDestination(w, v.lanelet, bodyClassOfArchetype(v.archetype));
    planFrom(w, v);
  }

  /** A car off the road taken out of the lots' list and of the drawn ones. */
  private drop(w: SimWorld, car: LotCar): void {
    this.cars.delete(car.id);
    if (car.body) w.ambient.removeParked(car.body);
  }

  /**
   * Whether nobody stands where the car will go over the rest of its way
   * (its body as three discs every metre): then it holds that ground and
   * drives it through. Kept waiting `ASK_WAY`, it goes on, the people
   * walking out of a car's ground (`walk.ts`), as at a drive's mouth.
   */
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
    let clear = true;
    for (const p of w.pedViews) {
      for (const d of discs) if (Math.hypot(p.x - d.x, p.y - d.y) < r) { clear = false; break; }
      if (!clear) break;
    }
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
