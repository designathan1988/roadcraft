import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';
import { bodyClassOfArchetype } from '../vehicles/archetypes';
import { routeToDestination } from './destination';
import { planTrip } from '../drive/tactical';
import { m } from '@world/units';
import { rebuildWork } from '@world/rebuildWork';

/** Horizon for a vehicle with no reachable boundary destination. */
const HORIZON = 24;
/** Bounded network lookahead used when comparing alternate turns. */
const LOOKAHEAD = 5;

/** DO NOT go back to the reverse edges of every lane of the map built for each topology */
class TrapIndex {
  /** Per body class asked for: the seeds, and the traps peeled from them (null: to peel again). */
  private readonly bodies = new Map<number, { readonly seeds: Set<LaneletId>; traps: ReadonlySet<LaneletId> | null }>();
  private seen: object | null = null;

  traps(w: SimWorld, body: number): ReadonlySet<LaneletId> {
    this.follow(w);
    let known = this.bodies.get(body);
    if (!known) this.bodies.set(body, known = { seeds: seedsOf(w, body), traps: null });
    return known.traps ??= peel(w, body, known.seeds);
  }

  /** The seeds brought up to the lane graph's changes since it was last. */
  private follow(w: SimWorld): void {
    const changes = w.topologyLog.since(this.seen);
    if (changes !== null && !changes.length) return;
    this.seen = w.topologyLog.state;
    if (changes === null) { this.bodies.clear(); return; }
    // The lanes whose exits may have changed: those the edits made or took, and those into the junctions they built again.
    const lanes = new Set<LaneletId>();
    for (const change of changes) {
      for (const lane of change.lanelets) lanes.add(lane);
      for (const node of change.junctions) for (const lane of w.graph.inbound.get(node) ?? []) lanes.add(lane);
    }
    for (const [body, known] of this.bodies) {
      for (const lane of lanes) {
        rebuildWork.routing++;
        if (w.graph.lanelets.get(lane)?.kind === 'link' && isSeed(w, lane, body)) known.seeds.add(lane);
        else known.seeds.delete(lane);
      }
      known.traps = null;
    }
  }
}

/** @rebuild Every lane with exits none of which this body fits. */
function seedsOf(w: SimWorld, body: number): Set<LaneletId> {
  const seeds = new Set<LaneletId>();
  for (const lane of w.graph.lanelets.values()) {
    rebuildWork.routing++;
    if (lane.kind === 'link' && isSeed(w, lane.id, body)) seeds.add(lane.id);
  }
  return seeds;
}

/** The movements out of a lane this body fits. */
function fittingExits(w: SimWorld, lane: LaneletId, body: number): number {
  let n = 0;
  for (const cid of w.graph.exitsOf(lane)) {
    const c = w.connector(cid);
    if (c && c.maxBodyClass >= body) n++;
  }
  return n;
}

/** A lane with exits none of which this body fits. */
const isSeed = (w: SimWorld, lane: LaneletId, body: number): boolean =>
  w.graph.exitsOf(lane).length > 0 && fittingExits(w, lane, body) === 0;

/** The traps: the seeds, and every lane whose movements this body fits all lead into traps, peeled back from them. */
function peel(w: SimWorld, body: number, seeds: ReadonlySet<LaneletId>): ReadonlySet<LaneletId> {
  const traps = new Set<LaneletId>(seeds);
  const left = new Map<LaneletId, number>();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    const from = w.graph.lanelets.get(id)?.from;
    const junction = from === undefined ? undefined : w.graph.junctions.get(from);
    // The movements into this lane: its junction's connectors that end on it.
    for (const cid of junction?.connectors ?? []) {
      rebuildWork.routing++;
      const c = w.connector(cid);
      if (!c || c.toLane !== id || c.maxBodyClass < body) continue;
      if (w.graph.lanelets.get(c.fromLane)?.kind !== 'link') continue;
      const d = (left.get(c.fromLane) ?? fittingExits(w, c.fromLane, body)) - 1;
      left.set(c.fromLane, d);
      if (d === 0 && !traps.has(c.fromLane)) { traps.add(c.fromLane); stack.push(c.fromLane); }
    }
  }
  return traps;
}

const trapIndexes = new WeakMap<SimWorld, TrapIndex>();
export function trapLanes(w: SimWorld, body: number): ReadonlySet<LaneletId> {
  let index = trapIndexes.get(w);
  if (!index) trapIndexes.set(w, index = new TrapIndex());
  return index.traps(w, body);
}

/** Route planning over the lanelet graph. */
export function planFrom(w: SimWorld, v: Vehicle): LaneletId | null {
  const body = bodyClassOfArchetype(v.archetype);
  const shape = v.archetype.shape;
  if (v.destination && w.lanelet(v.lanelet)?.kind === 'link') {
    // The trip is planned over the whole carriageway, lane changes included
    const plan = planTrip(w, v.lanelet, v.s, v.destination, body, true, shape);
    if (plan) {
      v.desiredLane = plan.changeTo;
      if (plan.changeTo) v.movementIntent = plan.intent;
      if (plan.route.length >= 3) {
        v.route = plan.route;
        w.noteRoute(v);
        if (!plan.changeTo) v.movementIntent = plan.route[1]!;
        return plan.route[1]!;
      }
      if (plan.changeTo) {
        // No way on from this lane towards the goal
        const own = w.graph.exitsOf(v.lanelet).filter((id) => (w.connector(id)?.maxBodyClass ?? -1) >= body);
        const pick = own.length ? chooseExit(w, own, body, new Set([v.lanelet]), shape) : null;
        const conn = pick ? w.connector(pick) : undefined;
        if (!pick || !conn) return null;
        v.route = [v.lanelet, pick, conn.toLane];
        w.noteRoute(v);
        return pick;
      }
    } else {
      v.destination = null;
    }
  }
  if (v.destination) {
    const trip = routeToDestination(w, v.lanelet, v.destination, body);
    const first = trip && trip.length >= 3 ? w.connector(trip[1]!) : undefined;
    if (trip && first) {
      v.route = trip;
      w.noteRoute(v);
      v.movementIntent = first.id;
      v.desiredLane = null;
      return first.id;
    }
    // A live edit may disconnect the original destination.
    if (!trip) v.destination = null;
  }
  const own = w.graph.exitsOf(v.lanelet).filter((id) => (w.connector(id)?.maxBodyClass ?? -1) >= body &&
    w.graph.laneUsable(w.connector(id)!.toLane, shape));

  // Lane discipline makes each turn legal from exactly one lane
  const siblings = w.graph.changeTargets(v.lanelet, shape);
  const union = siblings.length
    ? [...own, ...siblings.flatMap((id: LaneletId) => w.graph.exitsOf(id))]
      .filter((id) => (w.connector(id)?.maxBodyClass ?? -1) >= body && w.graph.laneUsable(w.connector(id)!.toLane, shape))
    : own;

  const existingIntent = v.movementIntent ? w.connector(v.movementIntent) : undefined;
  const wanted = existingIntent &&
      existingIntent.maxBodyClass >= body &&
      (existingIntent.fromLane === v.lanelet || siblings.includes(existingIntent.fromLane))
    ? existingIntent.id
    : union.length ? chooseExit(w, union, body, new Set([v.lanelet]), shape) : null;
  const wantedConnector = wanted === null ? null : w.connector(wanted);
  v.movementIntent = wantedConnector?.id ?? null;
  if (wantedConnector && wantedConnector.fromLane !== v.lanelet) {
    v.desiredLane = wantedConnector.fromLane;
  } else {
    v.desiredLane = null;
  }

  // The route itself always starts where the vehicle actually IS.
  if (!own.length) return null;
  const best = wantedConnector?.fromLane === v.lanelet
    ? wantedConnector.id : chooseExit(w, own, body, new Set([v.lanelet]), shape);
  if (!best) return null;

  const conn = w.connector(best);
  if (!conn) return null;

  v.route = [v.lanelet, best, conn.toLane];
  w.noteRoute(v);
  extend(w, v);
  return best;
}

/** Grows a route forward until it reaches the horizon or a dead end. */
export function extend(w: SimWorld, v: Vehicle): void {
  const body = bodyClassOfArchetype(v.archetype);
  const shape = v.archetype.shape;
  if (v.destination) {
    const tail = v.route[v.route.length - 1];
    if (tail === v.destination) return;
    const lane = tail ? w.lanelet(tail) : undefined;
    if (lane?.kind === 'link') {
      const plan = planTrip(w, tail!, 0, v.destination, body, true, shape);
      // A change due on the tail lane is planned when the car gets there
      if (plan) {
        if (!plan.changeTo) { v.route.push(...plan.route.slice(1)); w.noteRoute(v); }
        return;
      }
      v.destination = null;
    }
  }
  if (v.destination) {
    const tail = v.route[v.route.length - 1];
    if (tail === v.destination) return;
    const suffix = tail ? routeToDestination(w, tail, v.destination, body) : null;
    if (suffix) { v.route.push(...suffix.slice(1)); w.noteRoute(v); return; }
    v.destination = null;
  }
  let guard = 0;
  const before = v.route.length;
  while (v.route.length < HORIZON && guard++ < HORIZON) {
    const tail = v.route[v.route.length - 1];
    if (tail === undefined) break;
    const lane = w.lanelet(tail);
    if (!lane || lane.kind !== 'link') break;

    const exits = w.graph.exitsOf(tail);
    if (!exits.length) break;

    const pick = chooseExit(w, exits, body, undefined, shape);
    if (!pick) break;
    const conn = w.connector(pick);
    if (!conn) break;

    // Do not loop straight back into a lanelet already on the route.
    if (v.route.includes(conn.toLane)) break;

    v.route.push(pick, conn.toLane);
  }
  if (v.route.length !== before) w.noteRoute(v);
}

function chooseExit(
  w: SimWorld,
  exits: readonly string[],
  body: ReturnType<typeof bodyClassOfArchetype>,
  visited = new Set<LaneletId>(),
  /** The vehicle's shape: a bus lane is buses only. */
  shape = 'car',
): string | null {
  const scored: { id: string; cost: number }[] = [];

  for (const cid of exits) {
    const conn = w.connector(cid);
    if (!conn || conn.maxBodyClass < body || !w.graph.laneUsable(conn.toLane, shape)) continue;
    const out = w.lanelet(conn.toLane);
    if (!out || w.rt(conn.toLane).ghost || visited.has(out.id)) continue;
    const cost = routeCost(w, cid, body, visited, LOOKAHEAD);
    if (Number.isFinite(cost)) scored.push({ id: cid, cost });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));

  // Spread the fleet only across genuinely comparable exits.
  const bestCost = scored[0]!.cost;
  const tolerance = Math.max(0.5, bestCost * 0.18);
  const comparable = scored
    .filter((candidate) => candidate.cost <= bestCost + tolerance)
    .slice(0, 3);
  const pick = comparable[Math.floor(w.rng.route.float() * comparable.length)] ?? comparable[0];
  return pick ? pick.id : null;
}

/** A small bounded search keeps the fallback moving without inventing a goal it cannot reach. */
function routeCost(
  w: SimWorld,
  connectorId: LaneletId,
  body: ReturnType<typeof bodyClassOfArchetype>,
  visited: Set<LaneletId>,
  remaining: number,
): number {
  const connector = w.connector(connectorId);
  if (!connector || connector.maxBodyClass < body) return Infinity;
  const out = w.lanelet(connector.toLane);
  if (!out || out.kind !== 'link' || visited.has(out.id) || w.rt(out.id).ghost) return Infinity;
  // A lane it could never leave, however far its way out is (`trapLanes`).
  if (trapLanes(w, body).has(out.id)) return Infinity;

  const runtime = w.rt(out.id);
  const density = runtime.order.length / Math.max(1, out.length / m(4.8));
  const travel = out.length / Math.max(m(0.2), out.speedLimit);
  const connectorTravel = connector.length / Math.max(m(0.2), out.speedLimit * 0.65);
  const turnPenalty = connector.turn === 'uturn' ? 4 : connector.turn === 'through' ? 0 : 0.35;
  const here = connectorTravel + travel * (1 + density * 2.6) + turnPenalty;
  const next = w.graph.exitsOf(out.id);
  // The road ends: the vehicle leaves the map there.
  if (!next.length) return here;
  // A lane it could enter and never leave: every way on is too tight for this body
  if (!next.some((id) => (w.connector(id)?.maxBodyClass ?? -1) >= body)) return Infinity;
  if (remaining <= 1) return here;

  // One set for the whole search, the lane added on the way down and taken out on the way back
  visited.add(out.id);
  let continuation = Infinity;
  for (const nextConnector of next) {
    continuation = Math.min(
      continuation,
      routeCost(w, nextConnector, body, visited, remaining - 1),
    );
  }
  visited.delete(out.id);
  // Keep the immediate choice meaningful even when a far-away branch is a marginally better fit
  return here + (Number.isFinite(continuation) ? continuation * 0.72 : 0);
}

/** Lets a driver who has been held up look for another way round. */
export function reconsiderRoute(w: SimWorld, v: Vehicle): void {
  if (v.heldUp < v.driver.patience) return;
  v.heldUp = 0;

  // A granted movement is a transaction in progress; a rear still inside a junction is the same.
  if (v.admittedConnector || v.clearingConnectors.length > 0) return;
  const lane = w.lanelet(v.lanelet);
  if (!lane || lane.kind !== 'link') return;
  // Too late to change anything: the movement is about to be requested.
  if (lane.length - v.s < v.archetype.length + v.driver.s0) return;

  v.movementIntent = null;
  planFrom(w, v);
}

/** Repairs a route whose lanelets no longer exist, after a live edit. */
export function repairRoute(w: SimWorld, v: Vehicle): void {
  const body = bodyClassOfArchetype(v.archetype);
  const current = w.lanelet(v.lanelet);
  if (!current) {
    v.route = [v.lanelet];
    w.noteRoute(v);
    return;
  }

  // A connector has exactly one legal continuation.
  if (current.kind === 'connector') {
    const connector = w.connector(current.id);
    const to = connector ? w.lanelet(connector.toLane) : undefined;
    v.route = to ? [current.id, to.id] : [current.id];
    w.noteRoute(v);
    extend(w, v);
    return;
  }

  const valid: LaneletId[] = [];
  let previous: LaneletId | undefined;
  for (const id of v.route) {
    const lane = w.lanelet(id);
    if (!lane) break;
    if (previous !== undefined && !isLegalTransition(w, previous, id, body)) break;
    valid.push(id);
    previous = id;
  }

  if (!valid.length || valid[0] !== v.lanelet) {
    v.route = [v.lanelet];
    w.noteRoute(v);
    planFrom(w, v);
    return;
  }

  v.route = valid;
  w.noteRoute(v);
  // A bare link route is valid data but not a usable junction intention.
  if (v.route.length < 2) {
    planFrom(w, v);
    return;
  }
  extend(w, v);
}

function isLegalTransition(w: SimWorld, fromId: LaneletId, toId: LaneletId,
  body: ReturnType<typeof bodyClassOfArchetype>): boolean {
  const from = w.lanelet(fromId);
  const to = w.lanelet(toId);
  if (!from || !to) return false;
  if (from.kind === 'link') {
    const connector = w.connector(toId);
    return !!connector && connector.maxBodyClass >= body && connector.fromLane === fromId;
  }
  const connector = w.connector(fromId);
  return !!connector && connector.toLane === toId;
}
