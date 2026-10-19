import { laneletId, type LaneletId } from '@world/lanelets';
import { newFrame, type Polyline } from '@core/polyline';
import type { SimWorld } from '../world';
import { m } from '@world/units';
import type { Vehicle } from './state';
import { DT, JAM_GAP, laneChangeLength, laneChangeOffset, laneChangeSlope } from '../params';
import { desiredSpeed } from './driver';
import { idmAccel, type Obstacle } from './idm';


/** How near the place it stops at a vehicle no longer changes lane, u. */
const COMMUTE_HOLD = m(60);
/** Lane choice: the route's, and the driver's. ## Two kinds of change */

/** Seconds of travel needed to complete a change, floored for a standing car. */
const LANE_CHANGE_TIME = 3.5;

/** Least room a mandatory change needs, whatever the speed. */
const LANE_CHANGE_MIN_ROOM = m(4);

/** Room a DISCRETIONARY change needs — six seconds of travel, and much more than the mandatory floor. */
const OVERTAKE_TIME = 6;
const OVERTAKE_MIN_ROOM = m(18);

/** Shortest interval between two discretionary changes by the same driver. */
const LANE_CHANGE_COOLDOWN = 6;

/** Bias towards the kerb side, in units of acceleration. */
const KEEP_SIDE_BIAS = 0.14;

/** Hardest braking a discretionary change may impose on the car behind. */
const SAFE_BRAKE_SHARE = 0.55;

/** An obstacle far enough away to be no obstacle at all. */
const CLEAR_ROAD: Obstacle = { gap: 1e6, speed: 1e6, kind: 'vehicle' };

/** Seconds a driver signals before moving across. */
const SIGNAL_LEAD = 1.4;
const SIGNAL_LEAD_CRAWLING = 0.8;

export function stepLaneChange(w: SimWorld): void {
  // Nothing moves in this stage: each lane's resting rears are worked out once for all of it (SIM-12).
  resting.open(w);
  try {
    decideLaneChanges(w);
  } finally {
    resting.close();
  }
}

function decideLaneChanges(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    v.laneChange = null;

    const lane = w.lanelet(v.lanelet);
    if (!lane || lane.kind !== 'link') {
      v.laneIntent = null;
      continue;
    }

    // The body still occupies the space between lanes until the previous manoeuvre finishes.
    if (Math.abs(v.lateral) > m(0.008)) continue;

    // A granted movement pins the lane
    if (v.admittedConnector || v.clearingConnectors.length > 0) {
      v.laneIntent = null;
      continue;
    }
    // Pulling in to the kerb, or standing there with a door open: the car stays where the errand put it (`kerbStops.ts`).
    if (v.kerbStop) {
      v.laneIntent = null;
      continue;
    }
    // Pulling in to the place it stops at on this lane (a bus at its stop, a resident's car at the bay it parks in)
    if (v.commute && v.commute.lanelet === lane.id && v.commute.at - v.s < COMMUTE_HOLD) {
      v.laneIntent = null;
      continue;
    }

    const target = v.desiredLane;
    let wanted: LaneletId | null = null;
    let mandatoryMove = false;
    if (target !== null && target !== lane.id) {
      wanted = mandatory(w, v, target);
      mandatoryMove = wanted !== null;
    } else if (target !== lane.id) {
      // Keep a discretionary intent alive while the move is still worth making: weighed (MOBIL) a few times a second, each driver on its own ticks (by its id); between, the intent stands while its lane is still beside and the room is there.
      wanted = (v.id + w.clock.tick) % MOBIL_EVERY === 0 ? discretionary(w, v, lane.id, lane.length, v.laneIntent) : standingIntent(w, v, lane.id, lane.length);
    }

    if (wanted === null) {
      v.laneIntent = null;
      continue;
    }
    if (wanted !== v.laneIntent) {
      v.laneIntent = wanted;
      v.laneIntentSince = v.age;
    }

    // Signal first; move once the lead has run and the gap is still there.
    const lead = mandatoryMove && v.v < CRAWL * 2 ? SIGNAL_LEAD_CRAWLING : SIGNAL_LEAD;
    if (v.age - v.laneIntentSince < lead) continue;
    if (!gapIsSafe(w, v, wanted)) continue;
    v.laneChange = wanted;
    v.laneIntent = null;
    v.lastLaneChangeAge = v.age;
  }
}

/** The adjacent lane the route asks for, or null when there is no longer room to get there */
function mandatory(w: SimWorld, v: Vehicle, target: LaneletId): LaneletId | null {
  const lane = w.lanelet(v.lanelet);
  const to = w.lanelet(target);
  if (!lane || !to || to.kind !== 'link' || w.rt(target).ghost || to.length < v.s ||
      lane.segment !== to.segment || lane.from !== to.from || lane.to !== to.to ||
      lane.laneIndex === undefined || to.laneIndex === undefined) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }

  const steps = Math.abs(to.laneIndex - lane.laneIndex);
  const adjacent = laneletId(lane.segment!, lane.from!, lane.to!,
    lane.laneIndex + Math.sign(to.laneIndex - lane.laneIndex));
  // Across a solid line, or into a bus lane it may not drive: no.
  if (steps === 0 || !w.lanelet(adjacent) || w.rt(adjacent).ghost || !w.graph.changeTargets(lane.id, v.archetype.shape).includes(adjacent)) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }
  // Give up only when even easing off to a crawl would not make it; short of that the driver slows down to fit
  if (lane.length - v.s < roomNeeded(w, v, adjacent, steps, Math.min(v.v, CRAWL))) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }
  return adjacent;
}

/** Road a mandatory change of `steps` lanes needs at `speed`: each lane is signalled for */
function roomNeeded(w: SimWorld, v: Vehicle, adjacent: LaneletId, steps: number, speed: number): number {
  return roomAt(v, sideways(w, v, adjacent), steps, speed);
}

/** `roomNeeded` with the lateral distance to the adjacent lane given (`sideways`): DO NOT project on the lanes again for each speed tried. */
function roomAt(v: Vehicle, across: number | null, steps: number, speed: number): number {
  const length = across === null ? 0 : laneChangeLength(across, speed, v.archetype.length);
  return (Math.max(LANE_CHANGE_MIN_ROOM, speed * LANE_CHANGE_TIME, length + FINISH_MARGIN) + speed * SIGNAL_LEAD_CRAWLING) * steps;
}

/** The speed a driver holds while working across to the lane the route needs. */
export function positioningSpeedCap(w: SimWorld, v: Vehicle): number {
  const target = v.desiredLane;
  if (target === null || target === v.lanelet) return Infinity;
  const lane = w.lanelet(v.lanelet);
  const to = w.lanelet(target);
  if (!lane || !to || lane.kind !== 'link' || lane.laneIndex === undefined || to.laneIndex === undefined ||
      lane.segment !== to.segment) return Infinity;
  const steps = Math.abs(to.laneIndex - lane.laneIndex);
  if (steps === 0) return Infinity;
  const adjacent = laneletId(lane.segment!, lane.from!, lane.to!,
    lane.laneIndex + Math.sign(to.laneIndex - lane.laneIndex));
  // A second of travel in hand, so the driver eases off before the room runs out rather than on the tick it does.
  const left = lane.length - v.s - v.v;
  // The distance across, measured once: only the change's length depends on the speed tried.
  const across = sideways(w, v, adjacent);
  if (roomAt(v, across, steps, Math.max(v.v, lane.speedLimit)) <= left) return Infinity;
  // Room falls with speed, so bisect for the fastest speed that still fits.
  let lo = 0;
  let hi = Math.max(v.v, lane.speedLimit);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (roomAt(v, across, steps, mid) <= left) lo = mid;
    else hi = mid;
  }
  // Never below a crawl: a change that needs less than that is not made.
  return Math.max(lo, CRAWL);
}

/** Kept clear of a stop line or a queue's tail when a change must be finished. */
const FINISH_MARGIN = m(6);
/** Below this a vehicle ahead is treated as standing, not as traffic to follow. */
const CRAWL = m(2);

/** Road a change into `target` from here would be driven over. */
function changeLength(w: SimWorld, v: Vehicle, target: LaneletId, speed = v.v): number {
  const across = sideways(w, v, target);
  return across === null ? 0 : laneChangeLength(across, speed, v.archetype.length);
}

/** How far across `target`'s centre lies from this vehicle's place on its lane; null when either lane is gone. */
function sideways(w: SimWorld, v: Vehicle, target: LaneletId): number | null {
  const lane = w.lanelet(v.lanelet);
  const other = w.lanelet(target);
  if (!lane || !other) return null;
  // The same projection asked up to four times a tick for a vehicle that has not moved (SIM-12): the last one is kept.
  const at = Math.min(Math.max(0, v.s), lane.length);
  const last = lastSideways;
  if (last.from === lane.centre && last.to === other.centre && last.at === at) return last.across;
  const across = other.centre.distanceTo(lane.centre.sampleAtInto(at, sidewaysFrame).p);
  last.from = lane.centre;
  last.to = other.centre;
  last.at = at;
  last.across = across;
  return across;
}

const sidewaysFrame = newFrame();
const lastSideways: { from: Polyline | null; to: Polyline | null; at: number; across: number } = { from: null, to: null, at: NaN, across: 0 };

/** Ticks between two weighings of a discretionary change by the same driver (MOBIL): a quarter of a second. */
const MOBIL_EVERY = Math.max(1, Math.round(0.25 / DT));

/** Between two weighings: the change being signalled, while it can still be made from here (its lane beside this one, room left). */
function standingIntent(w: SimWorld, v: Vehicle, laneId: LaneletId, laneLength: number): LaneletId | null {
  const intent = v.laneIntent;
  if (intent === null || laneLength - v.s < Math.max(OVERTAKE_MIN_ROOM, v.v * OVERTAKE_TIME)) return null;
  return w.graph.changeTargets(laneId, v.archetype.shape).includes(intent) && !w.rt(intent).ghost ? intent : null;
}

/** The change the driver wants: the best neighbouring lane, or none. */
function discretionary(
  w: SimWorld,
  v: Vehicle,
  laneId: LaneletId,
  laneLength: number,
  signalling: LaneletId | null,
): LaneletId | null {
  if (v.age - v.lastLaneChangeAge < LANE_CHANGE_COOLDOWN) return null;
  if (laneLength - v.s < Math.max(OVERTAKE_MIN_ROOM, v.v * OVERTAKE_TIME)) return null;
  // MOBIL weighs the accelerations round a change into a neighbouring lane
  const targets = w.graph.changeTargets(laneId, v.archetype.shape);
  if (!targets.length) return null;
  // The street the route turns into next.
  const turnInto = nextOutSegment(w, v);

  const here = w.lanelet(laneId);
  const index = here?.laneIndex ?? 0;
  const wanted = desiredSpeed(v.driver, v.v0, v.age);

  // "Does this lane go anywhere" is asked with `exitsOf`, not with the router's cost.
  const onward = w.graph.exitsOf(laneId).length > 0;
  const ahead = leaderIn(w, laneId, v.s, v.id);
  const behind = followerIn(w, laneId, v.s - v.archetype.length, v.id);
  const mine = idmAccel(v.driver, v.v, wanted, ahead ?? CLEAR_ROAD);

  let bestGain = 0;
  let best: LaneletId | null = null;

  for (const candidate of targets) {
    const to = w.lanelet(candidate);
    if (!to || to.kind !== 'link' || w.rt(candidate).ghost) continue;
    if (Math.abs((to.laneIndex ?? 0) - index) !== 1) continue;
    if (to.length < v.s) continue;
    // Never move into a dead end — but only when the lane being left is not one itself.
    if (onward && w.graph.exitsOf(candidate).length === 0) continue;
    if (turnInto !== null && !w.graph.exitsOf(candidate)
      .some((id) => w.connector(id)?.outSegment === turnInto)) continue;

    const theirLeader = leaderIn(w, candidate, v.s, v.id);
    const theirFollower = followerIn(w, candidate, v.s - v.archetype.length, v.id);

    // Would the car behind me over there have to brake harder than a driver reasonably can?
    let follower = 0;
    if (theirFollower) {
      const f = theirFollower.vehicle;
      const before = idmAccel(
        f.driver,
        f.v,
        f.v0,
        leaderIn(w, candidate, f.s, f.id) ?? CLEAR_ROAD,
      );
      const after = idmAccel(f.driver, f.v, f.v0, {
        gap: Math.max(m(0.02), v.s - v.archetype.length - f.s),
        speed: v.v,
        kind: 'vehicle',
      });
      if (after < -f.driver.bEmergency * SAFE_BRAKE_SHARE) continue;
      follower = after - before;
    }

    // And the car behind me here, which I am about to stop blocking.
    let released = 0;
    if (behind) {
      const o = behind.vehicle;
      const before = idmAccel(o.driver, o.v, o.v0, {
        gap: Math.max(m(0.02), v.s - v.archetype.length - o.s),
        speed: v.v,
        kind: 'vehicle',
      });
      const after = idmAccel(o.driver, o.v, o.v0, ahead
        ? { gap: Math.max(m(0.02), ahead.gap + (v.s - o.s)), speed: ahead.speed, kind: 'vehicle' }
        : CLEAR_ROAD);
      released = after - before;
    }

    const theirs = idmAccel(v.driver, v.v, wanted, theirLeader ?? CLEAR_ROAD);
    const outward = (to.laneIndex ?? 0) > index;
    const bias = outward ? KEEP_SIDE_BIAS : -KEEP_SIDE_BIAS;
    const gain = theirs - mine + v.driver.politeness * (follower + released) + bias;

    // Once signalling, the driver carries on while it is still worth it at all; a fresh decision needs the full threshold.
    const threshold = candidate === signalling ? v.driver.laneThreshold * 0.35 : v.driver.laneThreshold;
    if (!(gain > threshold && gain > bestGain)) continue;
    // Deciding needs only a gap that could open; the move itself waits for the indicator and then checks the gap again
    if (candidate !== signalling && !gapIsSafe(w, v, candidate)) continue;
    bestGain = gain;
    best = candidate;
  }

  return best;
}

/** Segment the planned next junction movement leaves by, or null when none is planned. */
function nextOutSegment(w: SimWorld, v: Vehicle): number | null {
  const next = v.route[1] ? w.connector(v.route[1]) : undefined;
  return next && next.fromLane === v.lanelet ? next.outSegment : null;
}

interface Neighbour {
  readonly vehicle: Vehicle;
  readonly gap: number;
  readonly speed: number;
  readonly kind: 'vehicle';
}

/** The nearest vehicle ahead of `s` in a lane, as an obstacle. */
function leaderIn(w: SimWorld, laneId: LaneletId, s: number, self: number): Neighbour | null {
  const order = w.rt(laneId).order;
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = w.veh(order[mid] as number);
    if ((at?.s ?? 0) <= s) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < order.length; i++) {
    const other = w.veh(order[i] as number);
    if (!other || other.id === self) continue;
    return {
      vehicle: other,
      gap: Math.max(m(0.02), other.s - other.archetype.length - s),
      speed: other.v,
      kind: 'vehicle',
    };
  }
  return null;
}

/** The nearest vehicle behind `rear` in a lane. */
function followerIn(w: SimWorld, laneId: LaneletId, rear: number, self: number): Neighbour | null {
  const order = w.rt(laneId).order;
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = w.veh(order[mid] as number);
    if ((at?.s ?? 0) < rear) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    const other = w.veh(order[i] as number);
    if (!other || other.id === self) continue;
    return {
      vehicle: other,
      gap: Math.max(m(0.02), rear - other.s),
      speed: other.v,
      kind: 'vehicle',
    };
  }
  return null;
}

/** Whether the body can get out of the lane it is in before whatever stands in that lane stops it. */
function canLeaveLane(w: SimWorld, v: Vehicle, target: LaneletId): boolean {
  const lane = w.lanelet(v.lanelet);
  const other = w.lanelet(target);
  if (!lane || !other) return true;
  const start = sideways(w, v, target)!;
  const length = laneChangeLength(start, v.v, v.archetype.length);
  const clear = shadowClearDistance(v, start, length);
  const need = clear + Math.max(JAM_GAP, v.driver.s0);
  if (resting.ahead(w, v.lanelet, v.s, v.id) - v.s < need) return false;
  // And any body still sliding out of this lane ahead of this one.
  for (const body of w.bodiesIn(v.lanelet)) {
    const ahead = body.vehicle;
    if (ahead.id === v.id || !ahead.shadow || ahead.shadow.lanelet !== v.lanelet) continue;
    const gap = body.s - ahead.archetype.length - v.s;
    if (gap >= -m(0.02) && gap < need && ahead.v < Math.max(v.v, CRAWL)) return false;
  }
  return true;
}

/** Where the rear of the nearest vehicle ahead of `s` in a lane will come to rest. */
function restingRearAhead(w: SimWorld, laneId: LaneletId, s: number, self: number): number {
  const order = w.rt(laneId).order;
  let limit = Infinity;
  let rear = Infinity;
  for (let i = order.length - 1; i >= 0; i--) {
    const ahead = w.veh(order[i] as number);
    if (!ahead || ahead.id === self) continue;
    if (ahead.s <= s) break;
    const own = ahead.v <= CRAWL ? ahead.s : ahead.s + restingReach(ahead);
    const nose = Math.max(ahead.s, Math.min(own, limit));
    rear = nose - ahead.archetype.length;
    limit = rear - Math.max(JAM_GAP, ahead.driver.s0);
  }
  return rear;
}

/**
 * `restingRearAhead` for every lane asked in one lane-change stage, each lane's cascade worked out once, head to tail (SIM-12):
 * the rear each vehicle comes to rest at, given the ones ahead of it, and a query finds where the walk from the head would stop.
 * Exact: the walk's answer is the rest of the last vehicle it passed, which does not depend on where it is stopped.
 * A lane whose order is not sorted by `s`, or a query whose own vehicle stands ahead of `s` in the lane, is walked as before.
 */
class RestingRears {
  private w: SimWorld | null = null;
  private readonly lanes = new Map<LaneletId, number>();
  /** Per lane from its offset: the count, then that many (s, rear, id) of its vehicles in the lane's order. */
  private data = new Float64Array(1024);
  private used = 0;

  open(w: SimWorld): void {
    this.w = w;
  }

  close(): void {
    this.w = null;
    this.lanes.clear();
    this.used = 0;
  }

  ahead(w: SimWorld, laneId: LaneletId, s: number, self: number): number {
    if (this.w !== w) return restingRearAhead(w, laneId, s, self);
    let at = this.lanes.get(laneId);
    if (at === undefined) this.lanes.set(laneId, at = this.build(w, laneId));
    if (at < 0) return restingRearAhead(w, laneId, s, self);
    const d = this.data, n = d[at]!, base = at + 1;
    // The last vehicle with its front at or behind `s`: where the walk from the head stops.
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[base + mid * 3]! <= s) lo = mid + 1;
      else hi = mid;
    }
    // The walk passes `self` without counting it: only when it stands ahead of `s` does that change the answer.
    const me = w.veh(self);
    if (me && me.s > s) {
      for (let k = lo; k < n && d[base + k * 3]! <= me.s; k++) if (d[base + k * 3 + 2] === self) return restingRearAhead(w, laneId, s, self);
    }
    return lo < n ? d[base + lo * 3 + 1]! : Infinity;
  }

  private build(w: SimWorld, laneId: LaneletId): number {
    const order = w.rt(laneId).order;
    const at = this.used;
    if (this.data.length < at + 1 + order.length * 3) {
      const more = new Float64Array(Math.max(this.data.length * 2, at + 1 + order.length * 3));
      more.set(this.data.subarray(0, at));
      this.data = more;
    }
    const d = this.data, base = at + 1;
    let n = 0, sorted = true, previous = -Infinity;
    for (let i = 0; i < order.length; i++) {
      const v = w.veh(order[i] as number);
      if (!v) continue;
      if (v.s < previous) sorted = false;
      previous = v.s;
      d[base + n * 3] = v.s;
      d[base + n * 3 + 2] = v.id;
      n++;
    }
    if (!sorted) return -1;
    // The cascade from the head, as `restingRearAhead` walks it.
    let limit = Infinity;
    for (let k = n - 1; k >= 0; k--) {
      const ahead = w.veh(d[base + k * 3 + 2]!)!;
      const own = ahead.v <= CRAWL ? ahead.s : ahead.s + restingReach(ahead);
      const nose = Math.max(ahead.s, Math.min(own, limit));
      const rear = nose - ahead.archetype.length;
      d[base + k * 3 + 1] = rear;
      limit = rear - Math.max(JAM_GAP, ahead.driver.s0);
    }
    d[at] = n;
    this.used = base + n * 3;
    return at;
  }
}

const resting = new RestingRears();

/** How much further a vehicle rolls before something standing holds it; Infinity when nothing does. */
function restingReach(v: Vehicle): number {
  let reach = Infinity;
  for (const o of v.constraints.obstacles) {
    if (o.speed > CRAWL) continue;
    reach = Math.min(reach, Math.max(0, o.gap));
  }
  return reach;
}

/** Room a driver leaves behind a vehicle standing at the kerb */
export function pullOutRoom(w: SimWorld, v: Vehicle): number {
  const lane = w.lanelet(v.lanelet);
  if (!lane || lane.kind !== 'link') return 0;
  let best = 0;
  let here: { readonly x: number; readonly y: number } | null = null;
  for (const sibling of w.graph.siblingLanes(lane.id)) {
    const other = w.lanelet(sibling);
    if (!other || Math.abs((other.laneIndex ?? 0) - (lane.laneIndex ?? 0)) !== 1) continue;
    here ??= lane.centre.sampleAtInto(Math.min(Math.max(0, v.s), lane.length), pullOutFrame).p;
    const start = other.centre.distanceTo(here);
    const length = laneChangeLength(start, 0, v.archetype.length);
    const room = shadowClearDistance(v, start, length) + Math.max(JAM_GAP, v.driver.s0);
    best = best === 0 ? room : Math.min(best, room);
  }
  return best;
}

const pullOutFrame = newFrame();

/** Road driven before no corner of the body is over the line between two lanes `start` apart, on a change `length` long */
function shadowClearDistance(v: Vehicle, start: number, length: number): number {
  const line = Math.abs(start) / 2;
  const steps = 24;
  // On the first half of the quintic change, the centre is still at least half a lane away, so its body cannot be clear.
  let lo = steps / 2, hi = steps;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const x = (length * mid) / steps;
    const offset = Math.abs(laneChangeOffset(start, x, length));
    const slope = Math.abs(laneChangeSlope(start, x, length));
    const angle = Math.atan(slope);
    const reach = (v.archetype.width / 2) * Math.cos(angle) + (v.archetype.length / 2) * Math.sin(angle);
    if (offset + reach <= line) hi = mid;
    else lo = mid;
  }
  return (length * hi) / steps;
}

/** Whether the target lane has room beside this vehicle right now. */
function gapIsSafe(w: SimWorld, v: Vehicle, target: LaneletId): boolean {
  if (!canLeaveLane(w, v, target)) return false;
  const rear = v.s - v.archetype.length;
  // Road the change itself will take, to be free of anybody slower ahead in the new lane.
  const finish = v.s + changeLength(w, v, target) + FINISH_MARGIN;
  // And to be over before the lane ends.
  const to = w.lanelet(target);
  if (to && to.kind === 'link' && finish > to.length) return false;
  // Nor to be caught by a queue in the new lane that is still rolling now but will have stopped before the change is over
  if (resting.ahead(w, target, v.s, v.id) < finish) return false;

  // Every BODY in the target lane, not just its occupancy list
  for (const body of w.bodiesIn(target)) {
    const other = body.vehicle;
    if (other.id === v.id) continue;

    const otherFront = body.s;
    const otherRear = otherFront - other.archetype.length;
    if (otherFront <= rear) {
      const gap = rear - otherFront;
      const need = Math.max(JAM_GAP, other.driver.s0) + other.v * other.driver.T * 0.5;
      if (gap < need) return false;
    } else if (otherRear >= v.s) {
      const gap = otherRear - v.s;
      const need = Math.max(JAM_GAP, v.driver.s0) + v.v * v.driver.T * 0.5;
      if (gap < need) return false;
      if (otherRear < finish && other.v < Math.max(v.v, CRAWL)) return false;
    } else {
      // Overlapping our own body length: no room at all.
      return false;
    }
  }
  return true;
}
