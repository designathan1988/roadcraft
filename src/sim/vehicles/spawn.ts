import { m, stepsIn } from '@world/units';
import {
  DT,
  DRIVER_NOISE,
  FLEET_CEILING,
  JAM_GAP,
  TRAFFIC_DENSITY,
} from '../params';
import type { SimWorld } from '../world';
import { type Archetype, archetypeWeights, bodyClassOfArchetype } from './archetypes';
import { makeDriver } from './driver';
import { idmAccel } from './idm';
import { createVehicle, snapshot, type Vehicle } from './state';
import { planFrom } from '../routing/router';
import { chooseVehicleDestination } from '../routing/destination';
import { assignOccupancy } from './kerbStops';
import { curveSpeedCap } from './curvature';

/** Arrival rate at one boundary entry lane, vehicles per second, at traffic intensity and demand 1 */
const ENTRY_RATE = 0.05;
/** Vehicles an entry holds outside the map before further arrivals are lost. */
const ENTRY_QUEUE = 6;
/** Arrivals a second at one entry with a number of cars chosen (`SimWorld.trafficCount`) once the map holds it */
const FILL_RATE = 0.25;
/** Most vehicles admitted onto the map in one tick, city-wide. */
const ADMIT_PER_TICK = 4;

/** Density ceiling on the fleet, from total road length. */
export function trafficTarget(w: SimWorld): number {
  const total = roadLength(w);
  // The number chosen; past one car per 12 m of road they would only stand bumper to bumper, so not more than that.
  const chosen = chosenTraffic(w);
  if (chosen !== null) {
    const ceiling = w.trafficCount !== null ? FLEET_CEILING : Math.floor(FLEET_CEILING * w.populationShare);
    return Math.min(ceiling, Math.max(0, Math.round(chosen)), Math.floor(stepsIn(total, 12)));
  }
  const ceiling = Math.floor(FLEET_CEILING * w.populationShare);
  return Math.min(
    ceiling,
    Math.floor(total * TRAFFIC_DENSITY * w.trafficIntensity * w.demandMultiplier),
  );
}

/** How many cars the map is kept at: the panel's count, or, following the city */
function chosenTraffic(w: SimWorld): number | null {
  if (w.trafficCount !== null) return w.trafficCount;
  if (!w.followCity) return null;
  return roadLength(w) * TRAFFIC_DENSITY * w.trafficIntensity * w.demandMultiplier;
}

/** The road length of a network, kept by what each rebuild changed (`world/networkLength.ts`). */
function roadLength(w: SimWorld): number {
  return w.roadLength.of(w.net);
}

/** DO NOT walk the map's lanes for an edit. */
function entryLanes(w: SimWorld): readonly string[] {
  let known = entries.get(w);
  if (!known) entries.set(w, known = { seen: null, lanes: new Set(), sorted: null });
  if (known.seen !== w.topologyLog.state) {
    const changes = w.topologyLog.since(known.seen);
    known.seen = w.topologyLog.state;
    const look = (id: string): void => { if (isEntry(w, id)) known!.lanes.add(id); else known!.lanes.delete(id); };
    if (changes === null) {
      // @rebuild A world's first topology, or a lane graph built whole.
      known.lanes.clear();
      for (const id of w.graph.lanelets.keys()) look(id);
    } else {
      for (const change of changes) {
        for (const id of change.lanelets) look(id);
        for (const node of change.junctions) for (const id of w.graph.outbound.get(node) ?? []) look(id);
      }
    }
    known.sorted = null;
  }
  const lanes = known.sorted ??= [...known.lanes].sort();
  // A lane retired by an edit still on its way out takes no arrival.
  for (const id of lanes) if (w.runtime.get(id)?.ghost) return lanes.filter((l) => !w.runtime.get(l)?.ghost);
  return lanes;
}
const entries = new WeakMap<SimWorld, { seen: object | null; readonly lanes: Set<string>; sorted: readonly string[] | null }>();

/** A link long enough to arrive on, starting at a node on the edge of the map. */
function isEntry(w: SimWorld, id: string): boolean {
  const lane = w.graph.lanelets.get(id);
  return !!lane && lane.kind === 'link' && lane.length >= m(12) && lane.from !== undefined && w.doc.mapEdge(lane.from);
}

/** Seconds to the next arrival of a Poisson stream of `rate` per second. */
function nextGap(w: SimWorld, rate: number): number {
  return -Math.log(1 - w.rng.spawnVehicles.float()) / Math.max(rate, 1e-9);
}

/** Brings traffic in at the edges of the map. */
export function stepDispatch(w: SimWorld, enabled: boolean): void {
  // A city with residents drives its own cars (`sim/city`): none come in.
  if (!w.edgeTraffic) return;
  if (!enabled) return;
  w.vehicleSpawnClock += DT;
  const now = w.vehicleSpawnClock;
  // A number of cars chosen (`SimWorld.trafficCount`)
  const chosen = chosenTraffic(w);
  const saturated = chosen !== null && chosen > 0 && w.vehicles.size < trafficTarget(w);
  const rate = chosen !== null ? (chosen > 0 ? FILL_RATE : 0)
    : ENTRY_RATE * w.trafficIntensity * w.demandMultiplier;
  const entries = entryLanes(w);

  const live = new Set(entries);
  for (const id of [...w.entryDemand.keys()]) if (!live.has(id)) w.entryDemand.delete(id);

  for (const id of entries) {
    let demand = w.entryDemand.get(id);
    if (!demand) {
      demand = { next: rate > 0 ? now + nextGap(w, rate) : Infinity, rate, waiting: [] };
      w.entryDemand.set(id, demand);
    }
    // The slider moved: the wait still to run is rescaled to the new rate, or drawn afresh when there was none (audit P1-20).
    if (demand.rate !== rate) {
      demand.next = rate <= 0 ? Infinity
        : demand.rate > 0 && Number.isFinite(demand.next) ? now + (demand.next - now) * (demand.rate / rate)
          : now + nextGap(w, rate);
      demand.rate = rate;
    }
    if (rate <= 0) continue;
    if (saturated && demand.waiting.length === 0) demand.waiting.push(now);
    while (demand.next <= now) {
      if (demand.waiting.length < ENTRY_QUEUE) demand.waiting.push(demand.next);
      else w.entryDemandLost++;
      demand.next += nextGap(w, rate);
    }
  }

  const cap = trafficTarget(w);
  const blocked = new Set<string>();
  for (let admitted = 0; admitted < ADMIT_PER_TICK && w.vehicles.size < cap; admitted++) {
    // Oldest waiting arrival first, anywhere on the map; ties by lane id.
    let best: string | null = null;
    let bestAt = Infinity;
    for (const id of entries) {
      if (blocked.has(id)) continue;
      const at = w.entryDemand.get(id)?.waiting[0];
      if (at !== undefined && at < bestAt) {
        best = id;
        bestAt = at;
      }
    }
    if (best === null) break;
    if (spawnAt(w, best)) w.entryDemand.get(best)?.waiting.shift();
    else blocked.add(best);
  }
}

/** Spawns one vehicle at the first entry lane with room for it. */
export function spawnVehicle(w: SimWorld): boolean {
  for (const id of entryLanes(w)) if (spawnAt(w, id)) return true;
  return false;
}

/** Puts one vehicle on the map at the start of an entry lane, if the lane has room behind whatever is already on it. */
function spawnAt(w: SimWorld, id: string): boolean {
  const lane = w.lanelet(id);
  if (!lane) return false;
  const arch = w.rng.spawnVehicles.weighted(archetypeWeights()) as Archetype;
  // A bus lane is buses only.
  if (!w.graph.laneUsable(id, arch.shape)) return false;
  // Do not materialise a bus on an entry whose junction has no movement its body can physically take.
  if (lane.to !== undefined && w.doc.degree(lane.to) > 1 &&
      w.graph.exitsOf(id).every((exit) =>
        (w.connector(exit)?.maxBodyClass ?? -1) < bodyClassOfArchetype(arch))) return false;
  // The tail includes a body still sliding out of this lane.
  let tailRear = Infinity;
  let tailSpeed = Infinity;
  for (const body of w.bodiesIn(id)) {
    const rear = body.s - body.vehicle.archetype.length;
    if (rear < tailRear) {
      tailRear = rear;
      tailSpeed = body.vehicle.v;
    }
  }
  const entryClearance = Math.max(m(0.2), Math.min(m(0.6), arch.width / 4));
  // `s` is the front of the vehicle.
  if (lane.length <= arch.length + entryClearance) return false;
  if (tailRear < arch.length + entryClearance + JAM_GAP) return false;
  // Nor onto people: the end of a road that leads off the map is where they cross from one footway to the other
  for (const s of [0, (arch.length + entryClearance) / 2, arch.length + entryClearance]) {
    const f = lane.centre.sampleAt(Math.min(lane.length, s));
    if (w.pedEngine.bridge.anyoneWithin(w, f.p.x, f.p.y, arch.width / 2 + m(1), null)) return false;
  }

  // The driver is drawn BEFORE the free-flow speed and from the same stream
  const driver = makeDriver(arch, () => w.rng.driver.float());
  const v0 =
    lane.speedLimit *
    arch.speedFactor *
    w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi) *
    // A pushy driver wants more than the limit and a timid one less, on top of the ordinary spread.
    (1 + driver.aggression * 0.07);

  const palette = arch.palette;
  const color = palette[Math.floor(w.rng.spawnVehicles.float() * palette.length)] as string;

  const vehicle = createVehicle(w.nextVehicleId++, arch, driver, color, id, v0, w.clock.tick);
  vehicle.s = arch.length + entryClearance;
  vehicle.v = birthSpeed(driver, v0, Math.min(v0 * 0.4, lane.speedLimit * 0.4),
    tailRear - vehicle.s, tailSpeed);
  vehicle.prev = snapshot(vehicle);

  assignOccupancy(w, vehicle);

  w.vehicles.set(vehicle.id, vehicle);
  w.enterLanelet(vehicle, id);
  vehicle.destination = chooseVehicleDestination(w, id, bodyClassOfArchetype(vehicle.archetype));
  // The check above sees only the first movement; this one, the way beyond it (`routeCost`)
  if (planFrom(w, vehicle) === null && w.graph.exitsOf(id).length > 0) {
    w.removeVehicle(vehicle);
    return false;
  }
  return true;
}

/** Puts one vehicle of `arch` on lane `id` with its front at arc `s` */
export function spawnVehicleAt(w: SimWorld, id: string, s: number, arch: Archetype): number | null {
  const lane = w.lanelet(id);
  if (!lane || lane.kind !== 'link' || !w.graph.laneUsable(id, arch.shape)) return null;
  if (s < arch.length + m(0.4) || s > lane.length - m(0.4)) return null;
  const rear = s - arch.length;
  let leaderGap = Infinity;
  let leaderSpeed = Infinity;
  let follower: Vehicle | null = null;
  let followerGap = Infinity;
  for (const body of w.bodiesIn(id)) {
    const front = body.s, back = body.s - body.vehicle.archetype.length;
    if (back - JAM_GAP < s && front + JAM_GAP > rear) return null;
    if (back >= s && back - s < leaderGap) { leaderGap = back - s; leaderSpeed = body.vehicle.v; }
    if (front <= rear && rear - front < followerGap) { followerGap = rear - front; follower = body.vehicle; }
  }
  for (const at of [rear, (rear + s) / 2, s]) {
    const f = lane.centre.sampleAt(Math.min(lane.length, Math.max(0, at)));
    if (w.pedEngine.bridge.anyoneWithin(w, f.p.x, f.p.y, arch.width / 2 + m(1), null)) return null;
  }
  const driver = makeDriver(arch, () => w.rng.driver.float());
  const v0 = lane.speedLimit * arch.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi) * (1 + driver.aggression * 0.07);
  const color = arch.palette[Math.floor(w.rng.spawnVehicles.float() * arch.palette.length)] as string;
  // Born at a cruise the car ahead allows
  const toEnd = Math.max(0, lane.length - s - driver.s0);
  const speed = Math.min(birthSpeed(driver, v0, v0 * w.rng.driver.range(0.6, 0.9), leaderGap, leaderSpeed),
    Math.sqrt(2 * driver.b * toEnd));
  // Nor in front of a car behind that could not keep its distance braking in comfort
  if (follower && idmAccel(follower.driver, follower.v, follower.v0,
    { gap: Math.max(m(0.004), followerGap), speed, kind: 'vehicle' as const }) < -follower.driver.b) return null;
  const vehicle = createVehicle(w.nextVehicleId++, arch, driver, color, id, v0, w.clock.tick);
  vehicle.s = s;
  vehicle.v = speed;
  // Nor faster than the bends ahead allow (SUMO inserts a vehicle only if it can brake for what is ahead, ibid.)
  vehicle.v = Math.min(vehicle.v, curveSpeedCap(w, vehicle));
  vehicle.prev = snapshot(vehicle);
  assignOccupancy(w, vehicle);
  w.vehicles.set(vehicle.id, vehicle);
  w.enterLanelet(vehicle, id);
  vehicle.destination = chooseVehicleDestination(w, id, bodyClassOfArchetype(vehicle.archetype));
  // Nowhere this body can go from here - every way on too tight for it - and it is not at a road's end: not inserted
  if (planFrom(w, vehicle) === null && w.graph.exitsOf(id).length > 0) {
    w.removeVehicle(vehicle);
    return null;
  }
  return vehicle.id;
}

/** How fast a vehicle arrives from off the map */
function birthSpeed(driver: ReturnType<typeof makeDriver>, v0: number, usual: number, gap: number, leaderSpeed: number): number {
  if (!Number.isFinite(gap)) return usual;
  const ahead = { gap: Math.max(m(0.004), gap), speed: Number.isFinite(leaderSpeed) ? leaderSpeed : 0, kind: 'vehicle' as const };
  if (idmAccel(driver, usual, v0, ahead) >= -driver.b) return usual;
  let lo = 0;
  let hi = usual;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (idmAccel(driver, mid, v0, ahead) >= -driver.b) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Removes the vehicles that reached the end of a road and stopped there: the only place a car leaves the map */
export function stepDespawn(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      w.removeVehicle(v);
      continue;
    }
    // The end-of-route obstacle brings a vehicle to rest at its standstill gap, not against the very end of the lane
    const atEnd = lane.length - v.s < v.driver.s0 + 2;
    const body = bodyClassOfArchetype(v.archetype);
    const nowhereToGo = w.graph.exitsOf(v.lanelet).every((id) =>
      (w.connector(id)?.maxBodyClass ?? -1) < body);
    const roadEnd = lane.to !== undefined && w.doc.mapEdge(lane.to);
    // A car of the ambient traffic that may be on screen waits there: taken away out of sight.
    if (lane.kind === 'link' && atEnd && nowhereToGo && roadEnd && !w.ambient.sighted.has(v.id)) {
      if (v.destination === lane.id) w.completedTrips++;
      w.removeVehicle(v);
    }
  }
}

;
