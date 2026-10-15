import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { canStopComfortably, type ConstraintSet, type Obstacle } from './idm';
import { PED_CROSSING_STOP_BUFFER, pedestrianInSpan } from '../intersections/crossingSpans';
import { divergeObstacle, findLeader, shadowLeaderObstacle } from './leaderIndex';
import { signalStateFor } from '../signals/query';
import { signalHolds } from '../signals/permission';
import { mergeRemaining, nextConnector } from '../intersections/admission';
import { kerbStopObstacle } from './kerbStops';
import { anyClosed, closedOn } from './laneClosures';
import { m } from '@world/units';
import { CROSSING_STOP } from '../transit/transit';
import { type CrossingId, makeCrossingId } from '../signals/plan';
import type { NodeId } from '@world/ids';

/** How far short of a closed stretch of lane the traffic stops. */
export const CLOSURE_STOP = m(1.5);

/** Stop short of a zebra span somebody is on; null when the path is clear. */
function pedestrianAhead(w: SimWorld, v: Vehicle): Obstacle | null {
  // Nobody on or at any zebra: nothing to look up.
  if (w.crossingStates.size === 0) return null;
  const lane = w.lanelet(v.lanelet);
  if (!lane) return null;
  let connectorId: string | undefined;
  let offset: number;
  if (lane.kind === 'connector') {
    connectorId = lane.id;
    offset = -v.s;
  } else if (v.admittedConnector) {
    connectorId = v.admittedConnector;
    offset = lane.length - v.s;
  } else if (v.route[0] === lane.id && v.route[1] !== undefined && w.connector(v.route[1])) {
    // Not admitted yet: the turn it plans.
    connectorId = v.route[1];
    offset = lane.length - v.s;
  } else {
    return null;
  }
  const conn = w.connector(connectorId);
  if (!conn) return null;
  let best: Obstacle | null = null;
  for (const crossing of crossingIdsAt(w, conn.node)) {
    const span = pedestrianInSpan(w, conn.id, crossing);
    if (!span) continue;
    // While still on a link, keep the whole vehicle behind the near edge of any zebra on the planned turn.
    const buffered = offset - PED_CROSSING_STOP_BUFFER;
    const gap = lane.kind === 'link'
      ? Math.max(0, canStopComfortably(v.driver, v.v, buffered - v.driver.s0) ? buffered : offset)
      : offset + span.along - PED_STOP_MARGIN;
    // Already over the span: stopping there would park on the zebra.
    if (gap < 0) continue;
    if (!best || gap < best.gap) best = { gap: Math.max(0, gap), speed: 0, kind: 'pedestrian' };
  }
  return best;
}

/** DO NOT drop every node's for an edit: the whole map's were spelt again after each road drawn. */
const CROSSING_IDS = new WeakMap<SimWorld, { seen: object | null; byNode: Map<NodeId, CrossingId[]> }>();
function crossingIdsAt(w: SimWorld, node: NodeId): readonly CrossingId[] {
  let memo = CROSSING_IDS.get(w);
  if (!memo) CROSSING_IDS.set(w, memo = { seen: null, byNode: new Map() });
  if (memo.seen !== w.topologyLog.state) {
    const changes = w.topologyLog.since(memo.seen);
    memo.seen = w.topologyLog.state;
    if (changes === null) memo.byNode.clear();
    else for (const change of changes) for (const junction of change.junctions) memo.byNode.delete(junction);
  }
  let ids = memo.byNode.get(node);
  if (!ids) memo.byNode.set(node, ids = (w.doc.node(node)?.incident ?? []).map((segment) => makeCrossingId(node, segment)));
  return ids;
}

/** The vehicle ahead on ANOTHER movement into the lane this one runs into. */
function mergeObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  const lane = w.lanelet(v.lanelet);
  const connectorId = lane?.kind === 'connector' ? lane.id : v.admittedConnector;
  const conn = connectorId ? w.connector(connectorId) : undefined;
  if (!conn) return null;
  const mine = mergeRemaining(w, v, conn);
  if (mine === null) return null;
  const junction = w.graph.junctions.get(conn.node);
  if (!junction) return null;
  let best: Obstacle | null = null;
  for (const otherId of junction.connectors) {
    if (otherId === conn.id) continue;
    const other = w.connector(otherId);
    if (!other || other.toLane !== conn.toLane) continue;
    const consider = (id: number): void => {
      const o = w.veh(id);
      if (!o || o.id === v.id) return;
      const theirs = mergeRemaining(w, o, other);
      if (theirs === null || theirs > mine || (theirs === mine && o.id > v.id)) return;
      const gap = mine - theirs - o.archetype.length;
      if (!best || gap < best.gap) best = { gap: Math.max(0, gap), speed: o.v, kind: 'vehicle' };
    };
    for (const id of w.rt(other.id).order) consider(id);
    for (const id of w.rt(other.fromLane).order) {
      if (w.veh(id)?.admittedConnector === other.id) consider(id);
    }
  }
  return best;
}

/** Extra space left in front of the zebra band (`CrossingSpan.along` already clears it). */
const PED_STOP_MARGIN = 0.5;

/** Turns the world into constraints for one vehicle. */
export function longitudinalConstraints(w: SimWorld, v: Vehicle): ConstraintSet {
  // The set the vehicle already carries, refilled
  const constraints: ConstraintSet = v.constraints ??= { obstacles: [] };
  const obstacles = constraints.obstacles;
  let n = 0;

  const leader = findLeader(w, v);
  if (leader) obstacles[n++] = leader;

  // A body that left the same stop line on another movement and is still sweeping the start both movements share.
  const diverging = divergeObstacle(w, v);
  if (diverging) obstacles[n++] = diverging;

  // A vehicle ahead on another movement into the same lane.
  const merging = mergeObstacle(w, v);
  if (merging) obstacles[n++] = merging;

  // A body still overlapping the lane it is sliding out of must not be driven into whatever is still there.
  const shadowLeader = shadowLeaderObstacle(w, v);
  if (shadowLeader) obstacles[n++] = shadowLeader;

  // A person on the stretch of a zebra this movement is about to drive over.
  const walker = pedestrianAhead(w, v);
  if (walker) obstacles[n++] = walker;

  // Pulling in to the kerb to let somebody out or in (`kerbStops.ts`).
  const kerb = kerbStopObstacle(v);
  if (kerb) obstacles[n++] = kerb;
  // A level crossing with a train coming (`sim/transit`): stopped short of it.
  for (let k = 0; k < Math.min(3, v.route.length); k++) {
    const closed = w.city.transit.closedOn(v.route[k]!);
    if (!closed.length) continue;
    let offset = -v.s;
    let reached = true;
    for (let j = 0; j < k; j++) {
      offset += w.lanelet(v.route[j]!)?.length ?? 0;
      if (offset > m(120)) { reached = false; break; }
    }
    if (!reached) break;
    for (const at of closed) {
      // Already over the line (its front past the track): it goes on across.
      if (offset + at <= 0) continue;
      obstacles[n++] = { gap: Math.max(0, offset + at - CROSSING_STOP), speed: 0, kind: 'signal' };
    }
  }
  // A stretch of lane closed by a lorry swinging across the street into a works' gate or out of it (`laneClosures.ts`)
  if (anyClosed(w)) {
    let offset = -v.s;
    for (let k = 0; k < Math.min(3, v.route.length) && offset <= m(120); k++) {
      if (k > 0) offset += w.lanelet(v.route[k - 1]!)?.length ?? 0;
      for (const c of closedOn(w, v.route[k]!)) {
        // Its front over the stretch's start already: it was let through before the stretch closed.
        if (offset + c.from <= 0) continue;
        obstacles[n++] = { gap: Math.max(0, offset + c.from - CLOSURE_STOP), speed: 0, kind: 'signal' };
      }
    }
  }
  // A resident's car pulling in at the door it is going to (`sim/city`).
  if (v.commute && v.lanelet === v.commute.lanelet) {
    obstacles[n++] = { gap: Math.max(0, v.commute.at - v.s + v.driver.s0), speed: 0, kind: 'kerbStop' };
  }

  const lane = w.lanelet(v.lanelet);
  if (!lane) { obstacles.length = n; return constraints; }

  // Distance to the end of the current lanelet.
  const dStop = Math.max(0, lane.length - v.s);

  if (lane.kind === 'link' && lane.controlled && !v.admittedConnector) {
    // Rails just short of the stop line: it waits for the junction before them, never on the track
    const track = w.city.transit.crossingNearEnd(lane.id, lane.length);
    if (track !== null && v.s < track) {
      obstacles[n++] = { gap: Math.max(0, track - CROSSING_STOP - v.s), speed: 0, kind: 'signal' };
    }
  }

  if (lane.kind === 'link' && lane.controlled) {
    // A vehicle with an admission token is never held at the stop line.
    if (!v.admittedConnector) {
      const conn = nextConnector(w, v);
      const controller = conn ? w.controller(conn.node) : undefined;
      const junction = conn ? w.graph.junctions.get(conn.node) : undefined;

      if (conn && controller && junction?.signalised) {
        const state = signalStateFor(controller, conn.group);
        const adjacentStop = w.crossingSpans.approachStop(lane.id);
        const signalGap = adjacentStop === undefined ? dStop :
          Math.min(dStop, Math.max(0, adjacentStop - v.s));
        // THE DRIVER, not the archetype.
        const mustStop = signalHolds(v, conn.id, state, conn.turn, signalGap);
        if (mustStop) {
          obstacles[n++] = { gap: signalGap, speed: 0, kind: 'signal' };
        }
      }
    }
  }

  // Nowhere left to go: stop at the end of the road rather than vanish mid-lane.
  if (v.route.length <= 1 && lane.kind === 'link') {
    obstacles[n++] = { gap: dStop, speed: 0, kind: 'endOfRoute' };
  }

  obstacles.length = n;
  return constraints;
}
