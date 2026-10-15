import type { NodeId } from '@world/ids';
import type { Connector } from '@world/lanelets';
import { CONVOY_ROLLING, JAM_GAP } from '../params';
import type { Vehicle } from '../vehicles/state';
import type { SimWorld } from '../world';

/** Don't-block-the-box, measured from real occupancy. */
/** `strict`: a movement that gives way */
export function hasDownstreamStorage(w: SimWorld, v: Vehicle, conn: Connector, strict = false): boolean {
  const rt = w.rt(conn.toLane);

  // Admission runs before integration.
  const committed: Vehicle[] = [];
  // A granted vehicle is still on this connector's inbound link or has entered the connector.
  for (const id of w.runtime.get(conn.fromLane)?.order ?? []) {
    const other = w.veh(id);
    if (other && other.id !== v.id && other.admittedConnector === conn.id) committed.push(other);
  }
  for (const id of w.runtime.get(conn.id)?.order ?? []) {
    const other = w.veh(id);
    if (other && other.id !== v.id && other.lanelet === conn.id) committed.push(other);
  }
  // Vehicle ids increase with insertion into `w.vehicles`
  committed.sort((a, b) => a.id - b.id);

  const out = w.lanelet(conn.toLane);

  // A sub-vehicle-length link is a shared part of its two junctions, not a storage lane.
  if (out && out.length < v.archetype.length + Math.max(JAM_GAP, v.driver.s0) &&
      (rt.order.length > 0 || committed.length > 0)) return false;

  // A physically empty lane with nobody on the way into it always accepts.
  if (rt.order.length === 0) {
    if (!committed.length || !out || (!strict && !endsAtSignal(w, out.to))) return true;
    let room = out.length;
    for (const other of committed) room -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    return room >= v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
  }

  if (!out) return false;

  // Free space runs from the lane entry to the rear bumper of its last vehicle.
  const tailId = rt.order[0];
  const tail = tailId === undefined ? undefined : w.veh(tailId);
  let free = tail ? tail.s - tail.archetype.length : out.length;
  // Anywhere else, the same as soon as the lane holds a queue that is going to stand
  const resting = restingRear(w, rt.order);
  if (endsAtSignal(w, out.to) || Number.isFinite(resting)) {
    // Towards a signal a rolling tail is not discharging: it is rolling up to whatever holds it, very often the red.
    free = Math.min(out.length, resting);
    for (const other of committed) {
      free -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    }
  } else if (tail && (strict || tail.v <= CONVOY_ROLLING)) {
    // A rolling tail is discharging and the existing convoy rules keep its followers moving.
    for (const other of committed) {
      free -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    }
  }
  // A refuge must still contain the whole vehicle when IDM stops it at its own standstill gap.
  return free >= v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
}

/** Where the rear of the last vehicle on a lane will come to rest. */
function restingRear(w: SimWorld, order: readonly number[]): number {
  let limit = Infinity;
  let rear = Infinity;
  for (let i = order.length - 1; i >= 0; i--) {
    const v = w.veh(order[i] as number);
    if (!v) continue;
    const own = v.v <= CONVOY_ROLLING ? v.s : v.s + standingReach(v);
    const nose = Math.max(v.s, Math.min(own, limit));
    rear = nose - v.archetype.length;
    limit = rear - Math.max(JAM_GAP, v.driver.s0);
  }
  return rear;
}

/** How much further a vehicle will go before something standing still holds it */
function standingReach(v: Vehicle): number {
  let reach = Infinity;
  for (const o of v.constraints.obstacles) {
    if (o.speed > CONVOY_ROLLING) continue;
    reach = Math.min(reach, Math.max(0, o.gap));
  }
  return reach;
}

/** Whether a lane ends at a signalised junction. */
function endsAtSignal(w: SimWorld, node: NodeId | undefined): boolean {
  if (node === undefined) return false;
  return w.graph.junctions.get(node)?.signalised ?? false;
}
