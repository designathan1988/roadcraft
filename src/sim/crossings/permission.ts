import { m } from '@world/units';
import { PED } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';
import type { SidewalkEdge } from '../peds/sidewalk';
import { pedestrianSignalState, signalStateFor } from '../signals/query';
import type { SignalController } from '../signals/fsm';
import { type CrossingId, makeCrossingId } from '../signals/plan';
import type { NodeId } from '@world/ids';
import { reservationCoversCrossing } from '../intersections/crossingSpans';
import { canStopComfortably } from '../vehicles/idm';
import { vehiclePose } from '../pose';

/* Whether somebody may step onto a zebra: the same rule for every pedestrian engine. */

/** Whether a pedestrian may step off the kerb. */
export function mayEnterCrossing(w: SimWorld, crossing: SidewalkEdge, waited: number): boolean {
  const node = crossing.node;
  const segment = crossing.segment;
  if (node === undefined || segment === undefined) return true;

  // A signal or accepted gap cannot make an occupied piece of road empty.
  if (vehicleBodyOnCrossing(w, crossing)) return false;

  const controller = w.controller(node);
  const junction = w.graph.junctions.get(node);
  const id = makeCrossingId(node, segment);

  // Connector admission is also a crossing reservation.
  if (crossingReservedByVehicle(w, node, segment, id)) return false;

  if (controller && junction?.signalised) {
    const state = pedestrianSignalState(controller, id, crossing.length);
    if (state !== 'walk') return false;
    // A car turning over this zebra at its own green, that has waited its share while people kept stepping off in front of it
    if (turnOwedToVehicle(w, node, id, controller)) return false;
    return true;
  }

  // Uncontrolled: accept a gap in the lanes actually being crossed.
  return pedGapAccepted(w, crossing, waited);
}

/** DO NOT key it by a `node:segment` text again */
type Reservation = { readonly v: Vehicle; readonly connector: string };
const RESERVATIONS = new WeakMap<SimWorld, Map<NodeId, Reservation[]>>();
/** The connectors one vehicle reserves, this tick: cleared and refilled, never reallocated. */
const reservedIds: string[] = [];
const alreadyReserved = (id: string): boolean => {
  for (const s of reservedIds) if (s === id) return true;
  return false;
};

export function indexReservations(w: SimWorld): void {
  const index = RESERVATIONS.get(w) ?? new Map<NodeId, Reservation[]>();
  index.clear();
  RESERVATIONS.set(w, index);
  // Only the vehicles at a junction (`SimWorld.junctionHolders`), not the fleet.
  for (const v of w.junctionHolders()) {
    const lane = w.lanelet(v.lanelet);
    // A vehicle mid-lane, clearing nothing and admitted nowhere, holds no reservation
    if (v.clearingConnectors.length === 0 && !v.admittedConnector && lane?.kind !== 'connector') continue;
    reservedIds.length = 0;
    for (const token of v.clearingConnectors) if (!alreadyReserved(token.connector)) reservedIds.push(token.connector);
    if (v.admittedConnector && !alreadyReserved(v.admittedConnector)) reservedIds.push(v.admittedConnector);
    if (lane?.kind === 'connector' && !alreadyReserved(lane.id)) reservedIds.push(lane.id);
    for (const connectorId of reservedIds) {
      const connector = w.connector(connectorId);
      if (!connector) continue;
      const list = index.get(connector.node);
      if (list) list.push({ v, connector: connectorId });
      else index.set(connector.node, [{ v, connector: connectorId }]);
    }
  }
}

function crossingReservedByVehicle(w: SimWorld, node: NodeId, segment: number, crossing: CrossingId): boolean {
  const filed = RESERVATIONS.get(w)?.get(node);
  if (!filed || !((w.doc.node(node)?.incident as readonly number[] | undefined)?.includes(segment) ?? false)) return false;
  for (const { v, connector: connectorId } of filed) {
    const connector = w.connector(connectorId);
    if (!connector || connector.node !== node) continue;
    const span = w.crossingSpans.span(connector.id, crossing);
    if (reservationCoversCrossing(w, v, connector, segment, span)) return true;
  }
  return false;
}

/** Whether a car at its line, at green */
function turnOwedToVehicle(w: SimWorld, node: NonNullable<SidewalkEdge["node"]>, crossing: string, controller: SignalController): boolean {
  for (const laneId of w.graph.junctions.get(node)?.inbound ?? []) {
    const head = w.laneHead(laneId);
    if (!head || head.admittedConnector || head.waited <= PED_COURTESY || !heldOnlyByPedestrians(w, head)) continue;
    const lane = w.lanelet(laneId);
    if (!lane || lane.length - head.s > m(8)) continue;
    const conn = head.route[1] ? w.connector(head.route[1]) : undefined;
    if (!conn || conn.node !== node) continue;
    if (w.crossingSpans.span(conn.id, crossing as never) === null) continue;
    if (signalStateFor(controller, conn.group) !== 'green') continue;
    return true;
  }
  return false;
}

/** Seconds a car stands at a zebra giving way to people arriving at its kerb before it is its turn. */
export const PED_COURTESY = 8;

/** Whether the only thing keeping a car at its line is people at or on a zebra */
function heldOnlyByPedestrians(w: SimWorld, v: Vehicle): boolean {
  return v.heldByPedestriansTick !== undefined && w.clock.tick - v.heldByPedestriansTick <= 1;
}

/** Gap acceptance against approaching traffic on the lanes being crossed. */
function pedGapAccepted(w: SimWorld, crossing: SidewalkEdge, waited: number): boolean {
  const impatience = Math.min(1.5, 0.05 * waited);
  const critical = Math.max(2.5, PED.criticalGap - impatience);

  for (const laneId of crossing.lanes ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane || lane.to !== crossing.node) continue;
    const head = w.laneHead(laneId);
    if (!head) continue;
    // A vehicle standing at its line is not arriving.
    if (head.v < 0.5 && !head.admittedConnector) {
      // Its turn: a car that has stood at the zebra this long while people kept stepping off in front of it goes next.
      if (head.waited > PED_COURTESY && heldOnlyByPedestrians(w, head)) return false;
      continue;
    }
    const distance = lane.length - head.s;
    const arrival = distance / Math.max(head.v, 0.5);
    if (arrival < critical || !canStopComfortably(head.driver, head.v, distance)) return false;
  }
  return true;
}

/** An approach vehicle's body can reach a zebra even without an admission token. */
function vehicleBodyOnCrossing(w: SimWorld, crossing: SidewalkEdge): boolean {
  for (const laneId of crossing.lanes ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane || lane.to !== crossing.node) continue;
    for (const body of w.bodiesIn(laneId)) {
      if (vehicleBodyIntersectsCrossing(w, body.vehicle, crossing)) return true;
    }
  }
  return false;
}

export function vehicleBodyIntersectsCrossing(w: SimWorld, vehicle: Vehicle, crossing: SidewalkEdge): boolean {
  const pose = vehiclePose(w, vehicle, 1);
  if (!pose) return false;
  const first = crossing.path.point(0);
  const last = crossing.path.point(crossing.path.n - 1);
  const at = pose.p;
  const ux = Math.cos(pose.angle), uy = Math.sin(pose.angle);
  const toBody = (x: number, y: number): { along: number; across: number } => {
    const dx = x - at.x, dy = y - at.y;
    return { along: dx * ux + dy * uy, across: -dx * uy + dy * ux };
  };
  const a = toBody(first.x, first.y), b = toBody(last.x, last.y);
  let lo = 0, hi = 1;
  const clip = (start: number, end: number, extent: number): boolean => {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) return Math.abs(start) <= extent;
    const t0 = (-extent - start) / delta, t1 = (extent - start) / delta;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    return lo <= hi;
  };
  return clip(a.along, b.along, vehicle.archetype.length / 2 + m(0.3)) &&
    clip(a.across, b.across, vehicle.archetype.width / 2 + m(0.3));
}
