import { DT, laneChangeLength, laneChangeOffset, laneChangeSlope } from '../params';
import { curveSpeedCap } from './curvature';
import { positioningSpeedCap } from './laneChange';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { desiredSpeed } from './driver';
import { physicalSpeed } from '../drive/physicalMotion';
import { planFrom } from '../routing/router';
import { bodyClassOfArchetype } from './archetypes';
import { COARSE_EPS } from '@core/scalar';
import { addScaled, dot, perp, sub } from '@core/vec2';
import { m } from '@world/units';

const CLEARANCE_EPSILON = COARSE_EPS;


/** The ONLY writer of `s`, `v` and `lanelet`. */
export function integrateAll(w: SimWorld): void {
  const removed: Vehicle[] = [];

  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      removed.push(v);
      continue;
    }

    // A lane change is a transfer between siblings at the same arc position, so it must land before the step is integrated
    const here = applyLaneChange(w, v) ?? lane;

    // The target speed wanders slowly, per driver.
    const wanted = desiredSpeed(v.driver, v.v0, v.age);
    // Bends ahead are taken at a comfortable lateral acceleration, braked for in advance (`curveSpeedCap`).
    const curveCap = Math.max(curveSpeedCap(w, v), v.v - v.driver.bEmergency * DT);
    // A driver still working across to the lane their turn needs eases off until the changes fit
    const positioning = Math.max(positioningSpeedCap(w, v), v.v - v.driver.b * DT);
    const speedCap = Math.min(wanted, here.speedLimit, curveCap, positioning);
    // The adaptive cruise control model with a driver's jerk limits (`drive/physicalMotion.ts`).
    const next = physicalSpeed(v.driver, v.v, speedCap, v.accel, v.constraints.obstacles, DT);
    const ds = Math.max(0, 0.5 * (v.v + next) * DT);
    // DO NOT make a set per car here: one per car at a junction, every tick.
    const clearancesAtStart = w.clearancesAtStart;
    clearancesAtStart.clear();
    for (const token of v.clearingConnectors) clearancesAtStart.add(token);

    v.accel = (next - v.v) / DT;
    v.v = next;
    v.s += ds;
    v.age += DT;

    // The change itself, a curve in DISTANCE eased at both ends: see `laneChangeOffset`.
    if (v.lateral !== 0) {
      v.lateralTravelled += ds;
      v.lateral = laneChangeOffset(v.lateralStart, v.lateralTravelled, v.lateralLength);
      v.lateralSlope = v.lateral === 0 ? 0
        : laneChangeSlope(v.lateralStart, v.lateralTravelled, v.lateralLength);
    } else {
      v.lateralSlope = 0;
    }
    if (v.shadow && (v.lateral === 0 || Math.abs(v.lateral) + sideReach(v) <= v.shadow.clearAt)) w.clearShadow(v);
    // What "held up" means, for the driver who is about to decide whether to look for another way round
    if (v.v < wanted * 0.34) v.heldUp += DT;
    else if (v.v > wanted * 0.6) v.heldUp = Math.max(0, v.heldUp - DT * 2);
    let travelled = ds;

    // Advance across lanelet boundaries, carrying the remainder.
    let guard = 0;
    while (guard++ < 16) {
      const current = w.lanelet(v.lanelet);
      if (!current || v.s <= current.length) break;
      const carried = v.s - current.length;
      if (!advance(w, v, carried)) {
        // Nowhere to go: hold at the end rather than vanish.
        travelled = Math.max(0, travelled - carried);
        discardUntravelledFromNewClearances(v, clearancesAtStart, carried);
        v.s = current.length;
        v.v = 0;
        break;
      }
    }

    const finalLane = w.lanelet(v.lanelet);
    if (finalLane && v.s > finalLane.length) {
      const discarded = v.s - finalLane.length;
      travelled = Math.max(0, travelled - discarded);
      discardUntravelledFromNewClearances(v, clearancesAtStart, discarded);
      v.s = finalLane.length;
      v.v = 0;
    }

    // A vehicle can span more than one junction when the link between them is shorter than its body.
    advanceClearanceTokens(w, v, travelled, clearancesAtStart);

    if (finalLane?.kind === 'connector' && v.claims.length) {
      w.claims.releasePassed(
        v.id,
        finalLane.id,
        v.s - v.archetype.length / 2,
        bodyClassOfArchetype(v.archetype),
        w.conflicts,
      );
    }

    if (travelled > m(0.008)) {
      v.lastMovedTick = w.clock.tick;
      v.waited = 0;
    } else {
      v.waited += DT;
    }

    // Right-on-red credit is earned by an actual full stop.
    if (
      finalLane?.kind === 'link' &&
      v.v < m(0.12) &&
      finalLane.length - v.s <= v.driver.s0 + 0.5
    ) {
      v.rorStopped += DT;
      if (v.rorStopped >= 1.0) v.rorCredit = true;
    } else if (v.v > 1) {
      v.rorStopped = 0;
      v.rorCredit = false;
    }
    // A copy of what it holds; nothing held and nothing kept, the empty list stays.
    const held = w.claims.points(v.id);
    if (held.length || v.claims.length) v.claims = [...held];
  }

  for (const v of removed) w.removeVehicle(v);

  // DO NOT walk `w.runtime` here: it is every lane anybody has ever been on.
  for (const id of w.occupied) {
    const rt = w.runtime.get(id);
    if (rt && rt.order.length > 1) w.sortLane(rt);
  }
}

/** Performs a lane change the lane-change stage already cleared as safe. */
function applyLaneChange(w: SimWorld, v: Vehicle): ReturnType<SimWorld['lanelet']> {
  const target = v.laneChange;
  v.laneChange = null;
  if (target === null || target === v.lanelet) return undefined;
  if (Math.abs(v.lateral) > m(0.008)) return undefined;

  const lane = w.lanelet(target);
  if (!lane || lane.kind !== 'link') return undefined;
  // The verdict was computed a stage ago.
  if (v.admittedConnector || v.clearingConnectors.length > 0) return undefined;
  if (v.s > lane.length) return undefined;

  // Carry the SIDEWAYS distance the transfer just covered
  const from = w.lanelet(v.lanelet);
  if (!from || from.segment !== lane.segment || from.from !== lane.from || from.to !== lane.to ||
      Math.abs((from.laneIndex ?? 0) - (lane.laneIndex ?? 0)) !== 1) return undefined;
  if (from) {
    // Anchored at the body's CENTRE, the point the drawing places
    const half = v.archetype.length / 2;
    const byCentre = v.s - half >= 0 && v.s - half <= from.length;
    const frame = from.centre.sampleAt(byCentre ? v.s - half : Math.min(v.s, from.length));
    // Where the vehicle is actually DRAWN, which is the centreline plus whatever is left of a previous change.
    const was = { p: addScaled(frame.p, perp(frame.t), v.lateral), t: frame.t };

    // ANCHOR BY POSITION, NOT BY ARC LENGTH.
    const anchor = lane.centre.closestPoint(was.p);
    const front = byCentre ? anchor.s + half : anchor.s;
    // The front past the new lane's end: no room to make the change here.
    if (front > lane.length) return undefined;
    const sOnOld = v.s;
    v.s = front;
    const now = lane.centre.sampleAt(anchor.s);
    v.lateral = dot(sub(was.p, now.p), perp(now.t));
    v.lateralStart = v.lateral;
    v.lateralTravelled = 0;
    v.lateralLength = laneChangeLength(v.lateral, v.v, v.archetype.length);
    v.lateralSlope = 0;

    // DUAL OCCUPANCY.
    w.addShadow(v, from.id, sOnOld - v.s, Math.abs(v.lateral) / 2);
  }

  w.exitLanelet(v, v.lanelet);
  v.lanelet = target;
  w.enterLanelet(v, target, false);
  if (v.desiredLane === target) v.desiredLane = null;
  // The plan from the new lane. DO NOT file the one-lane route first: `planFrom` files the route it plans; only one it gives up on is filed here.
  const bare = v.route = [target];
  planFrom(w, v);
  if (v.route === bare) w.noteRoute(v);
  return lane;
}

/** How far the body reaches sideways from its own centreline */
function sideReach(v: Vehicle): number {
  const angle = Math.atan(Math.abs(v.lateralSlope));
  return (v.archetype.width / 2) * Math.cos(angle) + (v.archetype.length / 2) * Math.sin(angle);
}

/** Removes overshoot that the next stop line rejected from newly-created tokens. */
function discardUntravelledFromNewClearances(
  v: Vehicle,
  clearancesAtStart: ReadonlySet<Vehicle['clearingConnectors'][number]>,
  distance: number,
): void {
  if (distance <= 0) return;
  for (const token of v.clearingConnectors) {
    if (!clearancesAtStart.has(token)) {
      token.distanceBeyondExit = Math.max(0, token.distanceBeyondExit - distance);
    }
  }
}

/** Advances rear-clearance ownership without consuming the next admission. */
function advanceClearanceTokens(
  w: SimWorld,
  v: Vehicle,
  distance: number,
  clearancesAtStart: ReadonlySet<Vehicle['clearingConnectors'][number]>,
): void {
  if (!v.clearingConnectors.length) return;

  const keep: Vehicle['clearingConnectors'] = [];
  for (const token of v.clearingConnectors) {
    const connector = w.connector(token.connector);
    if (!connector) continue;

    if (clearancesAtStart.has(token)) token.distanceBeyondExit += distance;
    if (token.distanceBeyondExit + CLEARANCE_EPSILON >= v.archetype.length) {
      w.claims.releaseConnector(v.id, connector.id, w.conflicts);
      continue;
    }

    const centreOnConnector =
      connector.length + token.distanceBeyondExit - v.archetype.length / 2;
    w.claims.releasePassed(v.id, connector.id, centreOnConnector,
      bodyClassOfArchetype(v.archetype), w.conflicts);
    keep.push(token);
  }
  v.clearingConnectors = keep;
}

/** Moves a vehicle onto the next lanelet on its route. */
function advance(w: SimWorld, v: Vehicle, carried: number): boolean {
  const current = w.lanelet(v.lanelet);
  let nextId = v.route[1];

  // Admission and integration share one token.
  if (current?.kind === 'link' && v.admittedConnector) {
    const admitted = w.connector(v.admittedConnector);
    if (!admitted || admitted.fromLane !== v.lanelet) return false;
    nextId = admitted.id;
    if (v.route[1] !== nextId) {
      const pinned = [v.lanelet, nextId, admitted.toLane];
      let expected = admitted.toLane;
      for (const reservedId of v.reservedConnectors) {
        const reserved = w.connector(reservedId);
        if (!reserved || reserved.fromLane !== expected) break;
        pinned.push(reserved.id, reserved.toLane);
        expected = reserved.toLane;
      }
      v.route = pinned;
      w.noteRoute(v);
    }
  }

  const next = nextId === undefined ? undefined : w.lanelet(nextId);

  if (!next || w.rt(next.id).ghost) {
    // The route is stale or the lanelet retired.
    if (v.admittedConnector) return false;
    planFrom(w, v);
    // A freshly planned connector has not passed admission yet.
    return false;
  }

  if (next.kind === 'connector' && v.admittedConnector !== next.id) return false;

  return advanceTo(w, v, next.id, carried);
}

function advanceTo(w: SimWorld, v: Vehicle, target: string, carried: number): boolean {
  const lane = w.lanelet(target);
  if (!lane) return false;

  const current = w.lanelet(v.lanelet);
  // A shadow is a position on a sibling of the CURRENT lane; it means nothing once the front has moved on.
  w.clearShadow(v);
  if (current?.kind === 'link' && lane.kind === 'connector') {
    v.desiredLane = null;
    v.movementIntent = null;
  }
  if (current?.kind === 'connector' && lane.kind === 'link') {
    v.desiredLane = null;
    v.movementIntent = null;
  }
  if (current) v.rearPath = [current.id, ...v.rearPath].slice(0, 32);
  if (
    current?.kind === 'connector' &&
    lane.kind === 'link'
  ) {
    const existing = v.clearingConnectors.find((token) => token.connector === current.id);
    if (existing) existing.distanceBeyondExit = Math.max(existing.distanceBeyondExit, carried);
    else {
      v.clearingConnectors.push({
        connector: current.id,
        distanceBeyondExit: carried,
      });
      w.noteHolder(v);
    }
    // Admission now describes only the movement the front is about to enter.
    if (v.admittedConnector === current.id) v.admittedConnector = null;
  }

  w.exitLanelet(v, v.lanelet);
  v.lanelet = target;
  // Keep the full carried distance.
  v.s = carried;
  w.enterLanelet(v, target);

  if (v.route[1] === target) v.route.shift();
  else v.route = [target, ...v.route.slice(1)];
  w.noteRoute(v);

  if (lane.kind === 'link') {
    if (v.reservedConnectors.length === 0) v.firstRequestTick = null;
  }
  return true;
}
