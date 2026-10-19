import type { NodeId, SegmentId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { CONVOY_ROLLING, CRITICAL_GAP, CRITICAL_GAP_FLOOR, IMPATIENCE_MAX, IMPATIENCE_RATE, JAM_GAP, REQUEST_MIN_DISTANCE, REQUEST_TIME, WAIT_CEILING } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';
import { canStopComfortably, type ObstacleKind } from '../vehicles/idm';
import { pedestrianSignalState, signalStateFor } from '../signals/query';
import { signalHolds } from '../signals/permission';
import { PED_COURTESY, vehicleBodyIntersectsCrossing } from '../crossings/permission';
import { hasDownstreamStorage } from './spillback';
import { cycleFull } from './cycles';
import { COARSE_EPS } from '@core/scalar';
import { m } from '@world/units';
import { CROSSING_STOP } from '../transit/transit';
import { bodyClassOfArchetype } from '../vehicles/archetypes';
import { slowestBend } from '../vehicles/curvature';
import { type Claim, type HolderState, zoneShareable } from './claims';
import { HEAVY, type ConflictPoint, type ConflictRef } from '@world/conflictPoints';
import { PED_BODY, PED_CROSSING_STOP_BUFFER, PED_MIN_PACE, PED_REACH_TIME, pedestrianInSpan } from './crossingSpans';
import { isHighwayClass, legRule } from '@world/roads/rules';

export type RowClass = 'signalGreen' | 'priority' | 'stop' | 'yield' | 'none';

interface Request {
  readonly v: Vehicle;
  readonly conn: Connector;
  /** Distance from the vehicle's nose to the stop line. */
  readonly d: number;
  readonly requestTick: number;
  readonly row: RowClass;
}

interface Verdict {
  readonly ok: boolean;
  readonly reason?: ObstacleKind;
  readonly reservations?: readonly ConnectorReservation[];
  /** A soft maximum claim was declared, but the red still forbids entry. */
  readonly reserveOnly?: boolean;
}

/** A head on red whose declared chain stands: reserve only, keep `reservedConnectors`. */
const KEEP_DECLARED: Verdict = { ok: true, reserveOnly: true };

interface ConnectorReservation {
  readonly connector: Connector;
  readonly points: readonly number[];
}

const RANK: Record<RowClass, number> = {
  signalGreen: 3,
  priority: 2,
  stop: 1,
  yield: 0,
  none: -1,
};

/** Grants or denies entry to every junction, once per tick. */
export function stepAdmission(w: SimWorld): void {
  // A pass's own movement tokens: they are compared only within it.
  MOVEMENT_TOKENS.clear();
  revokeStaleGrants(w);
  // Who was admitted to which connector, and who holds anything
  admittedBy = new Map();
  holders = new Set();
  // Only the vehicles at a junction (`SimWorld.junctionHolders`)
  for (const v of w.junctionHolders()) {
    if (v.admittedConnector) {
      const list = admittedBy.get(v.admittedConnector);
      if (list) list.push(v); else admittedBy.set(v.admittedConnector, [v]);
    }
    if (holdsAnything(w, v)) holders.add(v);
  }
  try {
    admit(w, new BankerPass(holders));
  } finally {
    pending = null;
    admittedBy = null;
    holders = null;
  }
}

/** This pass's vehicles by the connector they were admitted to. Null outside `stepAdmission`. */
let admittedBy: Map<string, Vehicle[]> | null = null;
/** This pass's vehicles that hold something (a non-empty allocation), and those granted something since it began. */
let holders: Set<Vehicle> | null = null;
/** A vehicle granted something in this pass: it holds now, and is admitted to `conn`. */
function granted(v: Vehicle, conn: string | null): void {
  holders?.add(v);
  if (conn === null || !admittedBy) return;
  const list = admittedBy.get(conn);
  if (!list) admittedBy.set(conn, [v]);
  else if (!list.includes(v)) list.push(v);
}

/** This pass's requests, by node. Null outside `stepAdmission`. */
let pending: Map<NodeId, Request[]> | null = null;

function admit(w: SimWorld, banker: BankerPass): void {
  const requests: Request[] = [];

  // Doing less (`SimWorld.doLess`): only the junctions somebody approaches.
  for (const node of w.doLess ? w.junctionsApproached() : w.junctionNodesInOrder()) {
    const junction = w.graph.junctions.get(node);
    if (!junction) continue;

    for (const laneId of junction.inbound) {
      const head = w.laneHead(laneId);
      if (!head) continue;
      // A vehicle already granted a movement never competes again.
      if (head.admittedConnector) continue;

      const conn = nextConnector(w, head);
      if (!conn) continue;

      const lane = w.lanelet(laneId);
      if (!lane) continue;
      const d = lane.length - head.s;
      // Waiting before rails just short of the line, it asks from there.
      const track = w.city.transit.crossingNearEnd(laneId, lane.length);
      const before = track === null ? 0 : lane.length - track + CROSSING_STOP + head.driver.s0 + m(2);
      if (d > Math.max(REQUEST_MIN_DISTANCE, head.v * REQUEST_TIME, before)) continue;

      const reservedCurrent = head.reservedConnectors[0] === conn.id;
      // A declared maximum claim pins the route.
      if (head.reservedConnectors.length > 0 && !reservedCurrent) {
        head.constraints.obstacles.push({
          gap: Math.max(0, d),
          speed: 0,
          kind: 'conflict',
        });
        continue;
      }

      if (head.firstRequestTick === null) head.firstRequestTick = w.clock.tick;

      requests.push({
        v: head,
        conn,
        d,
        requestTick: head.firstRequestTick,
        row: rightOfWay(w, node, head, conn, d),
      });
    }
  }

  // A compact maximum claim spans nodes, so arbitration must span nodes too.
  requests.sort(byPriority);
  pending = new Map();
  for (const r of requests) {
    const list = pending.get(r.conn.node);
    if (list) list.push(r);
    else pending.set(r.conn.node, [r]);
  }

  // A zone that reaches back over a stop line cannot be protected by a claim alone
  for (const r of requests) {
    const stop = stopShortOfIntrusion(w, r.v, r.conn, r.d);
    if (stop !== null) r.v.constraints.obstacles.push({ gap: stop, speed: 0, kind: 'conflict' });
  }

  for (const r of requests) {
    const verdict = evaluate(w, r, banker);
    if (verdict.ok) {
      const reservations = verdict.reservations ?? [];
      if (verdict.reserveOnly) {
        // `reservedConnectors` is a Banker's maximum claim, not physical ownership. Kept as it is when the chain asked for is the one declared (no `reservations`): the same ids, and the same array for `reconcileReservedChain`'s memo (SIM-10).
        if (verdict.reservations) {
          r.v.reservedConnectors = reservations.map(
            (reservation) => reservation.connector.id,
          );
        }
        banker.changed(r.v);
        // `longitudinalConstraints` has already pushed the signal obstacle for this vehicle from the same `mustStopAtSignal`
        if (!r.v.constraints.obstacles.some((o) => o.kind === 'signal')) {
          r.v.constraints.obstacles.push({
            gap: Math.max(0, r.d),
            speed: 0,
            kind: 'signal',
          });
        }
        continue;
      }

      const current = reservations[0];
      if (current) {
        w.claims.grantAll(
          r.v.id,
          current.connector.id,
          current.points,
          w.clock.tick,
        );
      }
      // The vehicle must know it holds these
      r.v.claims = [...w.claims.points(r.v.id)];
      if (r.v.reservedConnectors[0] === r.conn.id) {
        r.v.reservedConnectors.shift();
      } else {
        r.v.reservedConnectors = reservations
          .slice(1)
          .map((reservation) => reservation.connector.id);
      }
      r.v.admittedConnector = r.conn.id;
      w.noteHolder(r.v);
      w.mergeTurn.set(r.conn.toLane, r.conn.fromLane);
      banker.changed(r.v);
      granted(r.v, r.conn.id);
      // Waiting time before admission is ordinary queueing, not time spent holding a reservation.
      r.v.lastMovedTick = w.clock.tick;
      // Keep the original age across a compound box so a holder which is able to finish cannot be demoted behind fresh requests
      if (r.v.reservedConnectors.length === 0) {
        r.v.firstRequestTick = null;
      }
      w.lastAdmission.set(r.conn.node, w.clock.tick);
    } else {
      // Denial for a person on a zebra must hold the entire vehicle before its near edge.
      if (verdict.reason === 'pedestrian') r.v.heldByPedestriansTick = w.clock.tick;
      const held = r.d - PED_CROSSING_STOP_BUFFER;
      const pedestrianGap = canStopComfortably(r.v.driver, r.v.v, held - r.v.driver.s0) ? held : r.d;
      r.v.constraints.obstacles.push({
        gap: Math.max(0, verdict.reason === 'pedestrian' ? pedestrianGap : r.d),
        speed: 0,
        kind: verdict.reason ?? 'signal',
      });
    }
  }
}

/** Takes back a grant whose signal went red before the vehicle used it. */
function revokeStaleGrants(w: SimWorld): void {
  // The admitted, in id order (`SimWorld.junctionHolders`, not the fleet).
  const admitted = w.junctionHolders().filter((v) => v.admittedConnector !== null).sort((a, b) => a.id - b.id);
  for (const v of admitted) {
    if (!v.admittedConnector) continue;
    const lane = w.lanelet(v.lanelet);
    // Only while the nose is still on the approach.
    if (!lane || lane.kind !== 'link') continue;

    const conn = w.connector(v.admittedConnector);
    if (!conn || conn.fromLane !== lane.id) continue;
    // The exit filled since the grant (spillback), and the holder stands short of its line
    const head = w.laneHead(lane.id);
    const cutIn = head !== undefined && head !== null && head !== v && head.admittedConnector !== conn.id;
    if (v.v <= CONVOY_ROLLING && (cutIn || !hasDownstreamStorage(w, v, conn) || stoppedForWalker(v, Math.max(0, lane.length - v.s)))) {
      w.claims.releaseConnector(v.id, conn.id, w.conflicts);
      v.claims = [...w.claims.points(v.id)];
      v.admittedConnector = null;
      v.reservedConnectors = [];
      continue;
    }
    const controller = w.controller(conn.node);
    if (!controller || !w.graph.junctions.get(conn.node)?.signalised) continue;

    const state = signalStateFor(controller, conn.group);
    if (state === 'green') continue;
    const d = Math.max(0, lane.length - v.s);

    // Still permitted to enter: an amber it cannot stop for, or a credited right on red.
    if (!signalHolds(v, conn.id, state, conn.turn, d)) continue;

    // Committed.
    if (!canStopComfortably(v.driver, v.v, d)) continue;

    w.claims.releaseConnector(v.id, conn.id, w.conflicts);
    v.claims = [...w.claims.points(v.id)];
    v.admittedConnector = null;
    // The compound chain was declared as one transaction with this grant.
    v.reservedConnectors = [];
  }
}

/** Deterministic global order: arrival, then right of way, distance and id. */
const byPriority = (a: Request, b: Request): number =>
  a.requestTick - b.requestTick ||
  RANK[b.row] - RANK[a.row] ||
  a.d - b.d ||
  a.v.id - b.v.id;

function evaluate(w: SimWorld, r: Request, banker: BankerPass): Verdict {
  if (r.conn.maxBodyClass < bodyClassOfArchetype(r.v.archetype)) return { ok: false, reason: 'conflict' };
  const alreadyDeclared = r.v.reservedConnectors[0] === r.conn.id;
  const chain = alreadyDeclared
    ? r.v.reservedConnectors.map((id) => w.connector(id)).filter((c): c is Connector => !!c)
    : compactReservationChain(w, r.v, r.conn);
  if (!chain) return { ok: false, reason: 'spillback' };
  if (alreadyDeclared && chain.length !== r.v.reservedConnectors.length) {
    return { ok: false, reason: 'spillback' };
  }
  // DO NOT build the chain's points for a head declared and still held at its red each tick (SIM-10): the reservation it would set is the one it holds.
  if (alreadyDeclared && chain.length > 0 && r.row === 'none') return KEEP_DECLARED;

  const reservations = chain.map((connector) => ({
    connector,
    points: w.conflicts.refs(connector.id).map((ref) => ref.point),
  }));

  const current = reservations[0];
  if (!current) return { ok: false, reason: 'spillback' };
  if (r.row === 'none') return { ok: true, reservations, reserveOnly: true };

  // Stop control is not merely a lower arbitration rank.
  if (r.row === 'stop' && r.v.v > m(0.16)) {
    return { ok: false, reason: 'yield' };
  }

  if (zipperHolds(w, r)) {
    return { ok: false, reason: 'conflict', reservations };
  }

  // Only the connector physically about to be entered becomes a hard claim.
  if (!w.claims.available(current.points, r.v.id, current.connector.id,
    bodyClassOfArchetype(r.v.archetype), w.conflicts, (claim) => holderState(w, claim),
    (point, claim) => mergeFollows(w, r, point, claim))) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (queuedBodyInZone(w, r.v, current.connector)) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (exitSwingBlocked(w, r.v, current.connector)) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (!convoyCanEnter(w, r, current.connector)) {
    return { ok: false, reason: 'conflict', reservations };
  }
  if (movementReservedByOther(w, r.v, r.conn)) {
    return { ok: false, reason: 'conflict', reservations };
  }

  if (!hasDownstreamStorage(w, r.v, r.conn, r.row === 'yield' || r.row === 'stop')) {
    return { ok: false, reason: 'spillback', reservations };
  }
  if (cycleFull(w, r.conn.fromLane, r.conn.toLane, r.v.archetype.length + Math.max(JAM_GAP, r.v.driver.s0))) {
    return { ok: false, reason: 'spillback', reservations };
  }
  if (outranksForExit(r)) {
    return { ok: false, reason: 'yield', reservations };
  }

  if (!bankerSafeAfterGrant(w, r.v, reservations, banker)) {
    return { ok: false, reason: 'conflict', reservations };
  }

  // Permissive movements must find a gap in the traffic they yield to
  if (
    (r.row === 'yield' || r.row === 'stop') &&
    r.v.waited < WAIT_CEILING &&
    !hasAcceptableGap(w, r)
  ) {
    return { ok: false, reason: 'yield' };
  }

  if (crossingBusy(w, r.conn) || crossingReachedFirst(w, r) || stoppedForWalker(r.v, r.d)) {
    return { ok: false, reason: 'pedestrian' };
  }
  if (pedestrianHasPriority(w, r)) {
    return { ok: false, reason: 'pedestrian' };
  }

  return { ok: true, reservations };
}

/** Whether this vehicle leaves the next place in a merge to the other lane. */
function zipperHolds(w: SimWorld, r: Request): boolean {
  if (w.mergeTurn.get(r.conn.toLane) !== r.conn.fromLane) return false;
  // A turn left untaken is no turn: when the other lane's head is held by something else
  if (r.v.waited > ZIP_PATIENCE) return false;
  for (const other of pending?.get(r.conn.node) ?? []) {
    if (other.v.id === r.v.id || other.v.admittedConnector) continue;
    if (other.conn.toLane !== r.conn.toLane || other.conn.fromLane === r.conn.fromLane) continue;
    if (RANK[other.row] < RANK[r.row]) continue;
    if (other.d <= ZIP_READY || other.v.v <= CONVOY_ROLLING) return true;
  }
  return false;
}

/** Whether this vehicle may join a merge behind a holder on the other movement. */
function mergeFollows(
  w: SimWorld,
  r: Pick<Request, 'v' | 'conn' | 'd'>,
  point: ConflictPoint,
  claim: Claim,
): boolean {
  if (point.kind !== 'merge') return false;
  // Only where one road narrows (a node of two legs: a lane drop, a taper).
  if ((w.doc.node(r.conn.node)?.incident.length ?? 0) !== 2) return false;
  const holder = w.veh(claim.vehicle);
  const theirs = w.connector(claim.connector);
  if (!holder || !theirs || theirs.toLane !== r.conn.toLane) return false;
  if (holder.v <= CONVOY_ROLLING) return false;
  const ahead = mergeRemaining(w, holder, theirs);
  if (ahead === null) return false;
  const mine = Math.max(0, r.d) + r.conn.length;
  return ahead + holder.archetype.length + Math.max(JAM_GAP, r.v.driver.s0) <= mine;
}

/** Distance from a vehicle's front to the start of the lane its movement runs into; negative once the front is past it. */
export function mergeRemaining(w: SimWorld, v: Vehicle, conn: Connector): number | null {
  if (v.lanelet === conn.id) return conn.length - v.s;
  if (v.lanelet === conn.fromLane) {
    const lane = w.lanelet(conn.fromLane);
    return lane ? lane.length - v.s + conn.length : null;
  }
  if (v.lanelet === conn.toLane) return -v.s;
  return null;
}

/** Seconds a head waits for the other lane to take its turn before going itself. */
const ZIP_PATIENCE = 4;
/** How close to its line a rolling head of the other lane must be to take its turn, world units (standing heads always may). */
const ZIP_READY = 8;

/** Whether a vehicle with a better right of way is waiting for the same lane out. */
function outranksForExit(r: Request): boolean {
  if (r.row !== 'yield' && r.row !== 'stop') return false;
  for (const other of pending?.get(r.conn.node) ?? []) {
    if (other.v.id === r.v.id || other.v.admittedConnector) continue;
    if (RANK[other.row] <= RANK[r.row]) continue;
    if (other.conn.toLane === r.conn.toLane) return true;
  }
  return false;
}

/** Movement chain that must be declared before entering `first`. */
export function compactReservationChain(
  w: SimWorld,
  v: Vehicle,
  first: Connector,
): Connector[] | null {
  const body = bodyClassOfArchetype(v.archetype);
  if (first.maxBodyClass < body) return null;
  const chain: Connector[] = [first];
  const seen = new Set([first.id]);
  let routeIndex = v.route.indexOf(first.id);
  if (routeIndex < 0) return null;

  let connector = first;
  while (true) {
    const out = w.lanelet(connector.toLane);
    if (!out || out.kind !== 'link') return null;
    const stoppingBuffer = Math.max(JAM_GAP, v.driver.s0);
    if (out.length + COARSE_EPS >= v.archetype.length + stoppingBuffer) return chain;

    const exits = w.graph.exitsOf(out.id).filter((id) => (w.connector(id)?.maxBodyClass ?? -1) >= body);
    const nextId = v.route[routeIndex + 2];
    if (nextId === undefined) {
      return exits.length === 0 ? chain : null;
    }
    const next = w.connector(nextId);
    if (!next || next.maxBodyClass < body || next.fromLane !== out.id || seen.has(next.id)) return null;

    chain.push(next);
    seen.add(next.id);
    connector = next;
    routeIndex += 2;
  }
}

/** Whether a connector with no conflict points is already spoken for. */
function movementReservedByOther(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  // Real conflict points already protect a same-path convoy.
  if (w.conflicts.refs(conn.id).length > 0) return false;

  const need = v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
  // Granted, but still on its approach: the movement is theirs.
  const admitted = admittedBy ? admittedBy.get(conn.id) ?? [] : w.vehicles.values();
  for (const other of admitted) if (other.id !== v.id && other.admittedConnector === conn.id) return true;
  // Already on it: only room decides (those on the connector, from its occupancy).
  for (const id of w.runtime.get(conn.id)?.order ?? []) {
    const other = w.vehicles.get(id);
    if (!other || other.id === v.id || other.lanelet !== conn.id) continue;
    if (other.s < need) return true;
  }
  return false;
}

/** Whether a vehicle WAITING at another movement's stop line is inside the area this one would sweep. */
/** Whether a long body turning into a lane would sweep a vehicle beside it. */
function exitSwingBlocked(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  // A long body only (`HEAVY`): a car's tail does not swing over the next lane.
  if (conn.turn === 'through' || bodyClassOfArchetype(v.archetype) < HEAVY) return false;
  const reach = v.archetype.length;
  for (const sibling of w.graph.siblingLanes(conn.toLane)) {
    for (const body of w.bodiesIn(sibling)) {
      if (body.vehicle.id === v.id) continue;
      if (body.s - body.vehicle.archetype.length < reach) return true;
    }
  }
  return false;
}

function queuedBodyInZone(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  const mine = bodyClassOfArchetype(v.archetype);
  for (const ref of w.conflicts.refs(conn.id)) {
    const point = w.conflicts.points[ref.point];
    const other = w.connector(ref.other);
    if (!point || !other) continue;
    const head = w.laneHead(other.fromLane);
    const lane = w.lanelet(other.fromLane);
    if (!head || !lane || head.id === v.id) continue;
    // An admitted head is protected by its own claim instead.
    if (head.admittedConnector) continue;
    // Only the movement the head is actually about to take.
    if (nextConnector(w, head)?.id !== other.id) continue;
    const z = point.zone(other.id, bodyClassOfArchetype(head.archetype), mine);
    if (!z) continue;
    const centre = head.s - lane.length - head.archetype.length / 2;
    if (centre >= z.enter) return true;
  }
  return false;
}

/** Distance to stop at so the body stays outside a zone that reaches back over the stop line while another movement holds */
function stopShortOfIntrusion(w: SimWorld, v: Vehicle, conn: Connector, d: number): number | null {
  const mine = bodyClassOfArchetype(v.archetype);
  let stop: number | null = null;
  for (const ref of w.conflicts.refs(conn.id)) {
    const point = w.conflicts.points[ref.point];
    if (!point) continue;
    for (const claim of w.claims.holdersAt(ref.point)) {
      if (claim.vehicle === v.id || claim.connector === conn.id) continue;
      // Ahead in the same merge: followed, not stopped short of.
      if (mergeFollows(w, { v, conn, d }, point, claim)) continue;
      const holder = holderState(w, claim);
      if (!holder) continue;
      const z = point.zone(conn.id, mine, holder.cls);
      const theirs = point.zone(claim.connector, holder.cls, mine);
      if (!z || !theirs || holder.centre > theirs.exit) continue;
      const frontAtEntry = z.enter + v.archetype.length / 2;
      if (frontAtEntry >= 0) continue;
      const gap = Math.max(0, d + frontAtEntry);
      stop = stop === null ? gap : Math.min(stop, gap);
    }
  }
  return stop;
}

/** A follower may share a same-path claim only at the stop line */
function convoyCanEnter(w: SimWorld, r: Request, conn: Connector): boolean {
  const points = w.conflicts.refs(conn.id).map((ref) => ref.point);
  if (!points.length) return true;
  const owners = new Map<number, Vehicle>();
  for (const point of points) {
    for (const claim of w.claims.holdersAt(point)) {
      // Holders on OTHER movements have already been judged by the claim table
      if (claim.vehicle === r.v.id || claim.connector !== conn.id) continue;
      const owner = w.veh(claim.vehicle);
      if (owner) owners.set(owner.id, owner);
    }
  }
  if (!owners.size) return true;

  // The gate is on MOTION, not on distance.
  const atLine = r.d <= Math.max(m(2.4), r.v.driver.s0 + m(0.8));
  if (!atLine && r.v.v <= CONVOY_ROLLING) return false;
  return [...owners.values()].every((owner) => {
    const lane = w.lanelet(owner.lanelet);
    const clearing = owner.clearingConnectors.some((token) => token.connector === conn.id);
    return (lane?.id === conn.id || clearing) && owner.v > CONVOY_ROLLING;
  });
}

/** A resource of the Banker's test as a number: a conflict point is its own index */
type ResourceKey = number;

/** DO NOT keep them for the session: every connector id ever met stayed in it, across every edit and every map opened. */
const MOVEMENT_TOKENS = new Map<string, number>();
function movementToken(connector: string): ResourceKey {
  let token = MOVEMENT_TOKENS.get(connector);
  if (token === undefined) MOVEMENT_TOKENS.set(connector, token = -1 - MOVEMENT_TOKENS.size);
  return token;
}

interface BankerProcess {
  readonly allocation: Set<ResourceKey>;
  readonly maximum: Set<ResourceKey>;
}

/** Conflict points plus a connector token for zero-point movements. */
const CONNECTOR_RESOURCES = new WeakMap<readonly ConflictRef[], readonly ResourceKey[]>();
function connectorResources(
  w: SimWorld,
  connector: Connector,
): readonly ResourceKey[] {
  const refs = w.conflicts.refs(connector.id);
  if (refs.length === 0) return [movementToken(connector.id)];
  let known = CONNECTOR_RESOURCES.get(refs);
  if (!known) {
    known = refs.map((ref) => ref.point);
    CONNECTOR_RESOURCES.set(refs, known);
  }
  return known;
}

/** Whether a vehicle holds anything at all, without building its sets. */
function holdsAnything(w: SimWorld, v: Vehicle): boolean {
  if (w.claims.points(v.id).length > 0) return true;
  if (v.admittedConnector && w.conflicts.refs(v.admittedConnector).length === 0) return true;
  for (const token of v.clearingConnectors) if (w.conflicts.refs(token.connector).length === 0) return true;
  const lane = w.lanelet(v.lanelet);
  return !!lane && lane.kind === 'connector' && w.conflicts.refs(lane.id).length === 0;
}

function actualAllocation(w: SimWorld, v: Vehicle): Set<ResourceKey> {
  const resources = new Set<ResourceKey>();
  for (const point of w.claims.points(v.id)) resources.add(point);

  const movements = new Set<string>();
  if (v.admittedConnector) movements.add(v.admittedConnector);
  for (const token of v.clearingConnectors) movements.add(token.connector);
  const lane = w.lanelet(v.lanelet);
  if (lane?.kind === 'connector') movements.add(lane.id);
  for (const connector of movements) {
    if (w.conflicts.refs(connector).length === 0) resources.add(movementToken(connector));
  }
  return resources;
}

/** What one vehicle holds and may yet claim, for the Banker's test. */
interface Holding {
  readonly allocation: Set<ResourceKey>;
  readonly maximum: Set<ResourceKey>;
}

/** The Banker's tests' view of one admission pass (`stepAdmission` makes one and drops it at the end). */
class BankerPass {
  private readonly holdings = new Map<number, Holding>();
  private byResource: Map<ResourceKey, Set<Vehicle>> | null = null;
  /** Vehicles whose holding changed since they were filed: filed again at the next test. */
  private readonly refile = new Set<Vehicle>();

  /** `holders`: this pass's set, which grants add to (`granted`). */
  constructor(private readonly holders: ReadonlySet<Vehicle>) {}

  holdingOf(w: SimWorld, vehicle: Vehicle): Holding {
    const known = this.holdings.get(vehicle.id);
    if (known) return known;
    const allocation = actualAllocation(w, vehicle);
    const maximum = new Set(allocation);
    for (const id of vehicle.reservedConnectors) {
      const connector = w.connector(id);
      if (!connector) continue;
      for (const resource of connectorResources(w, connector)) maximum.add(resource);
    }
    const holding = { allocation, maximum };
    this.holdings.set(vehicle.id, holding);
    return holding;
  }

  /** A grant or a reservation changed what this vehicle holds or may claim. */
  changed(v: Vehicle): void {
    const old = this.holdings.get(v.id);
    this.holdings.delete(v.id);
    if (!this.byResource) return;
    if (old) for (const resource of old.maximum) this.byResource.get(resource)?.delete(v);
    this.refile.add(v);
  }

  /** The holders filed under each resource of their maximum claims. */
  filed(w: SimWorld): ReadonlyMap<ResourceKey, ReadonlySet<Vehicle>> {
    if (!this.byResource) {
      this.byResource = new Map();
      for (const v of this.holders) this.file(w, v);
    } else {
      for (const v of this.refile) if (this.holders.has(v)) this.file(w, v);
    }
    this.refile.clear();
    return this.byResource;
  }

  private file(w: SimWorld, v: Vehicle): void {
    const { allocation, maximum } = this.holdingOf(w, v);
    if (!allocation.size) return;
    for (const resource of maximum) {
      let filed = this.byResource!.get(resource);
      if (!filed) this.byResource!.set(resource, filed = new Set());
      filed.add(v);
    }
  }
}

/** Each Banker's verdict with the applicant and the movements asked for: for the specs only (`tests/sim/admissionGroup.spec.ts`). */
export const admissionProbe: {
  banker: ((w: SimWorld, applicant: Vehicle, proposal: readonly Connector[], safe: boolean) => void) | null;
} = { banker: null };

/** DO NOT go back to iterating every holder (`holders`, `w.vehicles`) here. */
function bankerSafeAfterGrant(
  w: SimWorld,
  applicant: Vehicle,
  proposal: readonly ConnectorReservation[],
  banker: BankerPass,
): boolean {
  const safe = bankerSafeInGroup(w, applicant, proposal, banker);
  admissionProbe.banker?.(w, applicant, proposal.map((p) => p.connector), safe);
  return safe;
}

function bankerSafeInGroup(
  w: SimWorld,
  applicant: Vehicle,
  proposal: readonly ConnectorReservation[],
  banker: BankerPass,
): boolean {
  const processes: BankerProcess[] = [];
  const owners = new Map<ResourceKey, number>();
  const universe = new Set<ResourceKey>();
  // The resources this grant concerns
  const mine = new Set<ResourceKey>();
  for (const intention of proposal) for (const r of connectorResources(w, intention.connector)) mine.add(r);
  for (const r of actualAllocation(w, applicant)) mine.add(r);

  // The applicant, as it would be after the grant.
  const allocation0 = actualAllocation(w, applicant);
  const maximum0 = new Set(allocation0);
  const current = proposal[0];
  if (current) {
    for (const resource of connectorResources(w, current.connector)) {
      allocation0.add(resource);
    }
  }
  for (const intention of proposal) {
    for (const resource of connectorResources(w, intention.connector)) {
      maximum0.add(resource);
    }
  }

  // Its group: the applicant first, then every holder sharing a resource of the maximum claims met so far
  const filed = banker.filed(w);
  const group: Holding[] = [{ allocation: allocation0, maximum: maximum0 }];
  const groupIds: number[] = [applicant.id];
  const met = new Set<number>([applicant.id]);
  const reached = new Set<ResourceKey>(maximum0);
  const frontier: ResourceKey[] = [...maximum0];
  while (frontier.length) {
    const resource = frontier.pop()!;
    for (const other of filed.get(resource) ?? []) {
      if (met.has(other.id)) continue;
      met.add(other.id);
      // Read only below: the sets are this pass's, shared across applicants.
      const holding = banker.holdingOf(w, other);
      group.push(holding);
      groupIds.push(other.id);
      for (const next of holding.maximum) {
        if (reached.has(next)) continue;
        reached.add(next);
        frontier.push(next);
      }
    }
  }

  for (let g = 0; g < group.length; g++) {
    const { allocation, maximum } = group[g]!;
    const vehicleId = groupIds[g]!;

    // A process that HOLDS NOTHING cannot be part of a deadlock.
    if (!allocation.size) continue;
    if (!maximum.size) continue;
    for (const resource of allocation) {
      const owner = owners.get(resource);
      if (owner !== undefined && owner !== vehicleId && !sharedConvoyResource(w, resource) && mine.has(resource)) return false;
      owners.set(resource, vehicleId);
      universe.add(resource);
    }
    for (const resource of maximum) universe.add(resource);
    processes.push({ allocation, maximum });
  }

  const work = new Set<ResourceKey>();
  for (const resource of universe) {
    if (!owners.has(resource)) work.add(resource);
  }

  const unfinished = new Set(processes.map((_, index) => index));
  let progressed = true;
  while (unfinished.size && progressed) {
    progressed = false;
    for (const index of [...unfinished]) {
      const process = processes[index];
      if (!process) continue;
      let canFinish = true;
      for (const resource of process.maximum) {
        if (!process.allocation.has(resource) && !work.has(resource)) {
          canFinish = false;
          break;
        }
      }
      if (!canFinish) continue;
      for (const resource of process.allocation) work.add(resource);
      unfinished.delete(index);
      progressed = true;
    }
  }
  return unfinished.size === 0;
}

/** A conflict resource may have several holders only while no two of them can touch there */
function sharedConvoyResource(w: SimWorld, resource: ResourceKey): boolean {
  // A `movement:` token stands for a connector that crosses nothing
  if (resource < 0) return true;
  const id = resource;
  const point = w.conflicts.points[id];
  const claims = w.claims.holdersAt(id);
  if (!point || claims.length === 0) return false;
  // Holders of one merge where a road narrows are a queue into one lane, kept apart by following (`mergeFollows`).
  if (point.kind === 'merge' && (w.doc.node(point.node)?.incident.length ?? 0) === 2) return true;
  const placed = claims.map((claim) => ({ connector: claim.connector, state: holderState(w, claim) }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a || !b || a.connector === b.connector) continue;
      if (!a.state || !b.state) return false;
      if (!zoneShareable(point, { connector: a.connector, state: a.state },
        { connector: b.connector, state: b.state })) return false;
    }
  }
  return true;
}

/** Where a claim holder's body is along the movement it holds. */
export function holderState(w: SimWorld, claim: Claim): HolderState | null {
  const v = w.veh(claim.vehicle);
  const conn = w.connector(claim.connector);
  if (!v || !conn) return null;
  const cls = bodyClassOfArchetype(v.archetype);
  const half = v.archetype.length / 2;
  if (v.lanelet === conn.id) return { cls, centre: v.s - half };
  if (v.lanelet === conn.fromLane) {
    const lane = w.lanelet(conn.fromLane);
    return lane ? { cls, centre: v.s - lane.length - half } : null;
  }
  const token = v.clearingConnectors.find((t) => t.connector === conn.id);
  if (token) return { cls, centre: conn.length + token.distanceBeyondExit - half };
  return null;
}

/** Right of way for one movement. */
export function rightOfWay(
  w: SimWorld,
  node: NodeId,
  v: Vehicle,
  conn: Connector,
  distanceToStop: number,
): RowClass {
  const controller = w.controller(node);
  const junction = w.graph.junctions.get(node);

  const policy = w.doc.node(node)?.control ?? 'auto';

  if (controller && junction?.signalised) {
    const state = signalStateFor(controller, conn.group);
    if (signalHolds(v, conn.id, state, conn.turn, distanceToStop)) return 'none';

    // A movement is protected when the current stage gives green to nothing that physically conflicts with it from another
    const stage = controller.plan.stages[controller.stageIndex];
    return state !== 'red' && stage?.protectedMovements.includes(conn.id) ? 'signalGreen' : 'yield';
  }

  // `RowClass 'none'` means "no right of way, stop"
  if (policy === 'stop') return 'stop';
  if (policy === 'yield') return 'yield';
  // A junction on "automatic" its flows put under a stop on every leg (V5).
  if (policy === 'auto' && w.advisor.choice(node) === 'stop') return 'stop';
  // Signs on each leg (`world/roads/rules.ts`): the leg's rule.
  if (policy === 'priority') {
    const n = w.doc.node(node);
    const rule = n ? legRule(w.doc, n, conn.inSegment) : 'yield';
    return rule === 'priority' ? 'priority' : rule;
  }
  // A mini-roundabout: every entry gives way (to whoever circulates, from the left: `yieldSide`).
  if (policy === 'mini') return 'yield';
  // Nothing signed (CTB art. 29, III): a "rodovia" goes before the road it meets
  if (policy === 'none') {
    const n = w.doc.node(node);
    const highwayHere = isHighwayClass(w.doc, conn.inSegment);
    const highwayElsewhere = (n?.incident ?? []).some((s) => s !== conn.inSegment && isHighwayClass(w.doc, s));
    if (highwayHere && !(n?.incident ?? []).every((s) => isHighwayClass(w.doc, s))) return 'priority';
    if (highwayElsewhere && !highwayHere) return 'yield';
    return 'yield';
  }

  // Unsignalised: the road the junction is ON goes first, everything joining it gives way.
  if (junction && conn.inSegment !== conn.outSegment && continues(w, node, conn)) {
    if (throughRank(w, conn) >= mainRoadRank(w, junction)) return 'priority';
  }
  return 'yield';
}

/** Authored priority, retaining the exact legacy class ordering on old roads. */
function throughRank(w: SimWorld, conn: Connector): number {
  const incoming = w.doc.segment(conn.inSegment);
  const outgoing = w.doc.segment(conn.outSegment);
  return Math.min(incoming?.section?.priority ?? incoming?.type ?? 0,
    outgoing?.section?.priority ?? outgoing?.type ?? 0);
}

/** Whether a movement carries its road on through the node */
function continues(w: SimWorld, node: NodeId, conn: Connector): boolean {
  return conn.turn === 'through' || conn.carried || (w.doc.node(node)?.incident.length ?? 0) === 2;
}

/** Rank of the road a junction is on, per topology build. */
const mainRoads = new WeakMap<JunctionTopology, number>();

function mainRoadRank(w: SimWorld, junction: JunctionTopology): number {
  let rank = mainRoads.get(junction);
  if (rank !== undefined) return rank;
  rank = -Infinity;
  for (const id of junction.connectors) {
    const conn = w.connector(id);
    if (!conn || conn.inSegment === conn.outSegment || !continues(w, junction.node, conn)) continue;
    rank = Math.max(rank, throughRank(w, conn));
  }
  mainRoads.set(junction, rank);
  return rank;
}

/** Gap acceptance against the movements this one yields to. */
function hasAcceptableGap(w: SimWorld, r: Request): boolean {
  const need = clearTime(w, r);
  const impatience = Math.min(IMPATIENCE_MAX, IMPATIENCE_RATE * r.v.waited);
  // The critical gap is the driver's, not the movement's.
  const critical = Math.max(
    CRITICAL_GAP_FLOOR,
    CRITICAL_GAP[r.conn.turn] * r.v.driver.gapFactor - impatience,
  );

  const mine = bodyClassOfArchetype(r.v.archetype);
  const side = yieldSide(w, r.conn);
  for (const ref of w.conflicts.refs(r.conn.id)) {
    const other = w.connector(ref.other);
    if (!other) continue;
    // Giving way only to one side (V5): to the right where nothing is signed, to the left
    if (side !== null && !comesFrom(w, r.conn, other, side)) continue;
    // A movement from the same approach is not a stream this one gives way to
    if (other.inSegment === r.conn.inSegment) continue;
    if (!movementIsActive(w, other)) continue;

    // Anything approaching on the conflicting movement's origin lane.
    const approach = w.laneHead(other.fromLane);
    if (!approach) continue;
    // A lane may fan out into several connectors.
    if (approach.id === r.v.id || nextConnector(w, approach)?.id !== other.id) continue;
    // Only a body that can actually reach this one is a reason to wait.
    if (!w.conflicts.points[ref.point]?.zone(r.conn.id, mine, bodyClassOfArchetype(approach.archetype))) {
      continue;
    }
    const lane = w.lanelet(other.fromLane);
    if (!lane) continue;

    // A vehicle sitting still at its own stop line is not arriving
    if (approach.v < 0.5 && !approach.admittedConnector && !protectedNow(w, other)) continue;

    const distance = lane.length - approach.s;
    const arrival = distance / Math.max(approach.v, 0.5);
    if (arrival < need + critical) return false;
  }
  return true;
}

/** Seconds for the FRONT to reach the point where the body has left the last conflict zone of this movement. */
function clearTime(w: SimWorld, r: Request): number {
  const refs = w.conflicts.refs(r.conn.id);
  const cls = bodyClassOfArchetype(r.v.archetype);
  let exit = -Infinity;
  for (const ref of refs) exit = Math.max(exit, ref.exit[cls] ?? -Infinity);
  const last = Number.isFinite(exit)
    ? Math.max(0, exit + r.v.archetype.length / 2)
    : r.conn.length;
  const lanelet = w.lanelet(r.conn.lanelet);
  const speed = Math.max(m(0.8), Math.min(r.v.v0, lanelet?.speedLimit ?? r.v.v0) * 0.6);
  return (r.d + last) / speed;
}

/** True when this movement is green and protected in the current stage. */
function protectedNow(w: SimWorld, conn: Connector): boolean {
  const controller = w.controller(conn.node);
  if (!controller || !w.graph.junctions.get(conn.node)?.signalised) return false;
  if (signalStateFor(controller, conn.group) !== 'green') return false;
  return controller.plan.stages[controller.stageIndex]?.protectedMovements.includes(conn.id) ?? false;
}

/** True when the other movement currently has permission to run. */
function movementIsActive(w: SimWorld, other: Connector): boolean {
  const controller = w.controller(other.node);
  const junction = w.graph.junctions.get(other.node);
  if (!controller || !junction?.signalised) return true;
  return signalStateFor(controller, other.group) !== 'red';
}

/** True when the vehicle stands for somebody on foot between its nose and its stop line */
function stoppedForWalker(v: Vehicle, toLine: number): boolean {
  if (v.v > CONVOY_ROLLING) return false;
  for (const o of v.constraints.obstacles) if (o.kind === 'pedestrian' && o.gap <= toLine + PED_BODY) return true;
  return false;
}

/** True when a pedestrian is on, or about to step onto, the stretch of a zebra this movement drives over (`CrossingSpans`). */
function crossingBusy(w: SimWorld, conn: Connector): boolean {
  for (const leg of crossingLegs(w, conn.node)) {
    if (pedestrianInSpan(w, conn.id, leg.id)) return true;
  }
  return false;
}

/** DO NOT spell a crossing's id (`node:segment`) per request per tick: a junction's, in the order of its legs, made once per node record (records are replaced, never edited). */
const CROSSINGS_AT = new WeakMap<object, readonly { readonly segment: SegmentId; readonly id: string }[]>();
function crossingLegs(w: SimWorld, node: NodeId): readonly { readonly segment: SegmentId; readonly id: string }[] {
  const record = w.doc.node(node);
  if (!record) return NO_LEGS;
  let legs = CROSSINGS_AT.get(record);
  if (!legs) CROSSINGS_AT.set(record, legs = record.incident.map((segment) => ({ segment, id: `${node}:${segment}` })));
  return legs;
}
const NO_LEGS: readonly { readonly segment: SegmentId; readonly id: string }[] = [];

/** Allowance over the estimated time for a front to reach a zebra it turns across. */
const CLEAR_MARGIN = 1.2;

/** Seconds to cover `d` from `v0`, accelerating at `a` up to `top`. */
function travelTime(d: number, v0: number, top: number, a: number): number {
  const accel = Math.max(0.5, a);
  const start = Math.min(v0, top);
  const reach = (top * top - start * start) / (2 * accel);
  if (d <= reach) return (-start + Math.sqrt(start * start + 2 * accel * d)) / accel;
  return (top - start) / accel + (d - reach) / top;
}

/** Whether somebody already on a zebra this movement crosses will reach the stretch it drives over before its body has */
function crossingReachedFirst(w: SimWorld, r: Request): boolean {
  // Only where stopping on the way blocks somebody
  if ((w.doc.node(r.conn.node)?.incident.length ?? 0) < 3) return false;
  const lane = w.lanelet(r.conn.lanelet);
  if (!lane) return false;
  let top = 0;
  for (const leg of crossingLegs(w, r.conn.node)) {
    const crossing = leg.id;
    const occupants = w.crossingStates.get(crossing)?.occupants;
    if (!occupants?.length) continue;
    const span = w.crossingSpans.span(r.conn.id, crossing);
    if (!span) continue;
    if (top === 0) top = Math.max(2, Math.min(lane.speedLimit, slowestBend(r.v, lane)));
    // `pedestrianAhead` stops a vehicle for anybody within `PED_REACH_TIME` of the stretch until its front is over it
    let front = CLEAR_MARGIN * travelTime(Math.max(0, r.d) + span.along, r.v.v, top, r.v.driver.a);
    // Nor before the vehicles already on this movement ahead of it
    front = Math.max(front, aheadOnMovement(w, r, span.along, top));
    for (const p of occupants) {
      // Somebody held still on the zebra is waiting for something - very often for this very car - and is not arriving.
      if (p.held) continue;
      const at = p.s;
      const ahead = p.forward ? span.s0 - PED_BODY - at : at - span.s1 - PED_BODY;
      if (ahead <= 0) continue;
      if (ahead / Math.max(p.v, PED_MIN_PACE) < front + PED_REACH_TIME) return true;
    }
  }
  return false;
}

/** The latest time, with `CLEAR_MARGIN`, at which a vehicle already admitted onto this movement */
function aheadOnMovement(w: SimWorld, r: Request, along: number, top: number): number {
  let latest = 0;
  const approach = w.lanelet(r.conn.fromLane);
  const consider = (o: Vehicle, distance: number): void => {
    if (o.id === r.v.id || distance <= 0) return;
    latest = Math.max(latest, CLEAR_MARGIN * travelTime(distance, o.v, top, o.driver.a));
  };
  for (const id of w.rt(r.conn.lanelet).order) {
    const o = w.veh(id);
    if (o) consider(o, along - o.s);
  }
  if (approach) {
    for (const id of w.rt(approach.id).order) {
      const o = w.veh(id);
      if (!o || o.admittedConnector !== r.conn.id || o.s <= r.v.s) continue;
      consider(o, approach.length - o.s + along);
    }
  }
  return latest;
}

/** Whether somebody waiting at a kerb has the right to cross in front of this movement before it is admitted */
function pedestrianHasPriority(w: SimWorld, r: Request): boolean {
  if (!canStopComfortably(r.v.driver, r.v.v, r.d)) return false;
  const controller = w.controller(r.conn.node);
  const signalised = !!controller && !!w.graph.junctions.get(r.conn.node)?.signalised;
  for (const { segment, id } of crossingLegs(w, r.conn.node)) {
    const state = w.crossingStates.get(id);
    if (!state || (state.waitingFrom === 0 && state.waitingTo === 0)) continue;
    // A car standing on the zebra itself is what keeps them at the kerb (nobody steps off with a body on it)
    const edge = w.sidewalks.edges.get(w.sidewalks.crossings.get(id) ?? '');
    if (edge && vehicleBodyIntersectsCrossing(w, r.v, edge)) continue;
    const span = w.crossingSpans.span(r.conn.id, id);
    if (span === null) continue;
    // Only people who would reach the vehicle's path soon after stepping off
    if (!signalised || !controller) {
      // No zebra painted here - a road carrying on at another width, a link too short for one - is no zebra
      if (w.net.crosswalkDistanceAt(segment, r.conn.node) <= 0) continue;
      // Waited its share giving way to people arriving at the kerb: its turn now (`PED_COURTESY`)
      if (r.v.waited > PED_COURTESY) continue;
      // Uncontrolled zebra: give way to those who would soon be in the path
      if (span) {
        const reach = PED_MIN_PACE * PED_REACH_TIME;
        const near = (state.waitingFrom > 0 && span.s0 < reach) || (state.waitingTo > 0 && state.length - span.s1 < reach);
        if (!near) continue;
      }
      return true;
    }
    // At a signal too, a car that has waited its share is owed its turn
    if (r.v.waited > PED_COURTESY) continue;
    if (pedestrianSignalState(controller, id, state.length) === 'walk') return true;
  }
  return false;
}

/** The connector this vehicle intends to take at the end of its lane. */
export function nextConnector(w: SimWorld, v: Vehicle): Connector | undefined {
  const next = v.route[1];
  if (next) {
    const c = w.connector(next);
    if (c && c.maxBodyClass >= bodyClassOfArchetype(v.archetype) && c.fromLane === v.lanelet) return c;
  }
  return undefined;
}

/** The side a movement gives way to at a junction whose rule is a side */
export function yieldSide(w: SimWorld, conn: Connector): 'right' | 'left' | null {
  const n = w.doc.node(conn.node);
  if (!n) return null;
  if (n.control === 'mini') return 'left';
  if (n.control !== 'none') return null;
  if (n.incident.some((s) => isHighwayClass(w.doc, s))) return null;
  return 'right';
}

/** Whether `other` arrives from `side` of `conn`'s driver: by the directions the two lanes come in on. */
export function comesFrom(w: SimWorld, conn: Connector, other: Connector, side: 'right' | 'left'): boolean {
  const mine = arrivalDirection(w, conn.fromLane);
  const theirs = arrivalDirection(w, other.fromLane);
  if (!mine || !theirs) return true;
  // Where the other comes FROM is behind its direction of travel; y is up, so a negative cross product is to the right.
  const cross = mine.x * -theirs.y - mine.y * -theirs.x;
  return side === 'right' ? cross < -1e-3 : cross > 1e-3;
}

function arrivalDirection(w: SimWorld, lane: string): { x: number; y: number } | null {
  const l = w.lanelet(lane);
  if (!l || l.centre.length < 0.5) return null;
  const end = l.centre.sampleAt(l.centre.length).p;
  const before = l.centre.sampleAt(Math.max(0, l.centre.length - m(2.4))).p;
  const len = Math.hypot(end.x - before.x, end.y - before.y) || 1;
  return { x: (end.x - before.x) / len, y: (end.y - before.y) / len };
}
