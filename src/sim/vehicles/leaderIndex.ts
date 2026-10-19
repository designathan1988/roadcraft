import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { canStopComfortably, type Obstacle } from './idm';
import { bodyClassOfArchetype } from './archetypes';
import { pullOutRoom } from './laneChange';
import { outOfTheWay } from './cycleLane';
import { m } from '@world/units';

/** How many lanelets ahead the leader search will walk. */
const LOOKAHEAD_HOPS = 3;

/** Nearest obstacle ahead, following the vehicle's own planned lanelet sequence. */
export function findLeader(w: SimWorld, v: Vehicle): Obstacle | null {
  const rt = w.rt(v.lanelet);
  const idx = laneSlot(w, rt.order, v);
  // The nearest so far, as numbers: DO NOT make an obstacle for every candidate and a closure to weigh them (a vehicle a step, SIM-07); one made for the winner. The first of the least gap wins, as before.
  let bestGap = Infinity, bestSpeed = 0, bestAccel = 0, found = false;

  // Ahead in the same lane: the list is ascending by arc position.
  if (idx >= 0 && idx + 1 < rt.order.length) {
    const aheadId = rt.order[idx + 1];
    let ahead = idx + 1;
    let lead = aheadId === undefined ? undefined : w.veh(aheadId);
    // Bicycles riding in the cycle lane are passed, not followed.
    while (lead && outOfTheWay(v, lead, w.lanelet(v.lanelet))) {
      const next = rt.order[++ahead];
      lead = next === undefined ? undefined : w.veh(next);
    }
    if (lead) {
      // Stopped at the kerb: hold back far enough to pull out round it - when there is still room to stop there in comfort.
      const standing = lead.kerbStop && lead.kerbStop.phase !== 'approach' ? pullOutRoom(w, v) : 0;
      const real = lead.s - lead.archetype.length - v.s;
      const hold = real - Math.max(0, standing - Math.max(v.driver.s0, 0));
      const gap = hold < real && canStopComfortably(v.driver, v.v, hold - v.driver.s0) ? hold : real;
      if (!found || gap < bestGap) { bestGap = gap; bestSpeed = lead.v; bestAccel = lead.accel; found = true; }
    }
  }
  for (const shadow of shadowsAhead(w, v.lanelet, v.s, v.id)) {
    const gap = shadow.rear - v.s;
    if (!found || gap < bestGap) { bestGap = gap; bestSpeed = shadow.vehicle.v; bestAccel = shadow.vehicle.accel; found = true; }
  }
  if (found) return { gap: bestGap, speed: bestSpeed, accel: bestAccel, kind: 'vehicle' };

  // Head of this lanelet: walk forward along the planned route.
  const here = w.lanelet(v.lanelet);
  if (!here) return null;

  let dist = here.length - v.s;
  const horizon = Math.max(
    m(20),
    v.v * v.driver.T * 3 + (v.v * v.v) / (2 * v.driver.b),
  );

  const upcoming = upcomingLanelets(w, v, LOOKAHEAD_HOPS);
  for (const nextId of upcoming) {
    if (dist > horizon) return null;
    const nrt = w.rt(nextId);
    const nextLane = w.lanelet(nextId);
    let tailAt = 0;
    let tail = nrt.order[0] === undefined ? undefined : w.veh(nrt.order[0]);
    while (tail && outOfTheWay(v, tail, nextLane)) {
      const next = nrt.order[++tailAt];
      tail = next === undefined ? undefined : w.veh(next);
    }
    if (tail) {
      const gap = dist + tail.s - tail.archetype.length;
      if (!found || gap < bestGap) { bestGap = gap; bestSpeed = tail.v; bestAccel = tail.accel; found = true; }
    }
    for (const shadow of shadowsAhead(w, nextId, -Infinity, v.id)) {
      const gap = dist + shadow.rear;
      if (!found || gap < bestGap) { bestGap = gap; bestSpeed = shadow.vehicle.v; bestAccel = shadow.vehicle.accel; found = true; }
    }
    if (found) return { gap: bestGap, speed: bestSpeed, accel: bestAccel, kind: 'vehicle' };
    const lanelet = w.lanelet(nextId);
    if (!lanelet) break;
    dist += lanelet.length;
  }

  return null;
}

/** DO NOT go back to `indexOf` for every vehicle */
function laneSlot(w: SimWorld, order: readonly number[], v: Vehicle): number {
  let lo = 0, hi = order.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const id = order[mid]!;
    if (id === v.id) return mid;
    const other = w.veh(id);
    const before = ((other?.s ?? 0) - v.s || id - v.id) < 0;
    if (before) lo = mid + 1;
    else hi = mid - 1;
  }
  return order.indexOf(v.id);
}

/** Rears of bodies sliding out of a lane, ahead of `s` on it. */
function shadowsAhead(
  w: SimWorld,
  laneId: LaneletId,
  s: number,
  self: number,
): { vehicle: Vehicle; rear: number }[] {
  const out: { vehicle: Vehicle; rear: number }[] = [];
  for (const id of w.rt(laneId).shadows) {
    if (id === self) continue;
    const other = w.veh(id);
    if (!other?.shadow || other.shadow.lanelet !== laneId) continue;
    const front = other.s + other.shadow.offset;
    if (front <= s) continue;
    out.push({ vehicle: other, rear: front - other.archetype.length });
  }
  return out;
}

/** The body of a vehicle that took a DIFFERENT movement out of the same lane */
export function divergeObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  const here = w.lanelet(v.lanelet);
  if (!here) return null;

  let connectorId: LaneletId | undefined;
  let offset: number;
  if (here.kind === 'connector') {
    connectorId = here.id;
    offset = -v.s;
  } else {
    // Only the vehicle nearest the stop line needs this; everyone behind it follows it.
    if (w.laneHead(here.id)?.id !== v.id) return null;
    connectorId = v.route[1];
    offset = here.length - v.s;
    const horizon = Math.max(m(20), v.v * v.driver.T * 3 + (v.v * v.v) / (2 * v.driver.b));
    if (offset > horizon) return null;
  }
  if (connectorId === undefined) return null;
  const siblings = w.conflicts.divergesOf(connectorId);
  if (!siblings.length) return null;

  const mine = bodyClassOfArchetype(v.archetype);
  let best: Obstacle | null = null;
  for (const d of siblings) {
    const other = w.connector(d.other);
    if (!other) continue;
    const candidates: { vehicle: Vehicle; front: number }[] = [];
    for (const id of w.rt(other.id).order) {
      const o = w.veh(id);
      if (o) candidates.push({ vehicle: o, front: o.s });
    }
    // Bodies whose front is already on the exit lane but whose tail may not be.
    for (const id of w.rt(other.toLane).order) {
      const o = w.veh(id);
      if (o && o.rearPath[0] === other.id) candidates.push({ vehicle: o, front: other.length + o.s });
    }
    for (const { vehicle: o, front } of candidates) {
      if (o.id === v.id) continue;
      const centre = front - o.archetype.length / 2;
      if (centre > d.otherExit(bodyClassOfArchetype(o.archetype), mine)) continue;
      // Whoever is further along the shared start leads.
      if (here.kind === 'connector' && front <= v.s) continue;
      const gap = offset + front - o.archetype.length;
      if (!best || gap < best.gap) best = { gap, speed: o.v, kind: 'vehicle' };
    }
  }
  return best;
}

/** Sideways clearance kept from a body in the lane being left, world units. */
const SHADOW_SIDE_MARGIN = m(0.16);

/** A vehicle mid-lane-change is itself an obstacle for its OWN forward motion against whatever it still overlaps in the */
export function shadowLeaderObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  if (!v.shadow) return null;
  const front = v.s + v.shadow.offset;
  // How far the FRONT of this body still reaches back towards the old lane's centre
  const spacing = 2 * v.shadow.clearAt;
  const angle = Math.atan(Math.abs(v.lateralSlope));
  const nearEdge = spacing - Math.abs(v.lateral) +
    (v.archetype.length / 2) * Math.sin(angle) - (v.archetype.width / 2) * Math.cos(angle);
  let best: Obstacle | null = null;
  for (const body of w.bodiesIn(v.shadow.lanelet)) {
    if (body.vehicle.id === v.id) continue;
    // Only a body this one can still touch.
    const reach = body.vehicle.archetype.width / 2 + Math.abs(body.vehicle.lateral) + SHADOW_SIDE_MARGIN;
    if (nearEdge >= reach) continue;
    const rear = body.s - body.vehicle.archetype.length;
    const gap = rear - front;
    if (gap < -v.archetype.length) continue; // already well behind: not a leader.
    if (!best || gap < best.gap) best = { gap, speed: body.vehicle.v, kind: 'vehicle' };
  }
  return best;
}

/** The next `n` lanelets on the vehicle's route, excluding the current one. */
function upcomingLanelets(w: SimWorld, v: Vehicle, n: number): LaneletId[] {
  const out: LaneletId[] = [];
  for (let i = 1; i < v.route.length && out.length < n; i++) {
    const id = v.route[i];
    if (id !== undefined && w.lanelet(id)) out.push(id);
  }
  return out;
}
