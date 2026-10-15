import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/** Stretches of lane closed for a while by something off the lanes standing on them */
export interface Closure {
  readonly lanelet: LaneletId;
  /** The stretch closed, arc positions along the lane. */
  readonly from: number;
  readonly to: number;
  /** Who closed it. */
  readonly owner: number;
}

const CLOSED = new WeakMap<SimWorld, Map<LaneletId, Closure[]>>();
const NONE: readonly Closure[] = [];

export function closeLane(w: SimWorld, closure: Closure): void {
  let byLane = CLOSED.get(w);
  if (!byLane) CLOSED.set(w, byLane = new Map());
  const list = byLane.get(closure.lanelet);
  if (list) list.push(closure); else byLane.set(closure.lanelet, [closure]);
}

/** Every stretch `owner` closed, opened again. */
export function openLanes(w: SimWorld, owner: number): void {
  const byLane = CLOSED.get(w);
  if (!byLane) return;
  for (const [lane, list] of byLane) {
    const kept = list.filter((c) => c.owner !== owner);
    if (kept.length) byLane.set(lane, kept); else byLane.delete(lane);
  }
}

/** The stretches closed on a lane now. */
export function closedOn(w: SimWorld, lanelet: LaneletId): readonly Closure[] {
  return CLOSED.get(w)?.get(lanelet) ?? NONE;
}

/** Whether any lane is closed at all (the commonest answer is no, and costs one look). */
export function anyClosed(w: SimWorld): boolean {
  const byLane = CLOSED.get(w);
  return !!byLane && byLane.size > 0;
}

/** Kept between a closed stretch and the nearest body on it or past it. */
const CLEAR_MARGIN = m(2);

/** Whether a stretch of lane may be closed now */
export function laneClear(w: SimWorld, lanelet: LaneletId, from: number, to: number, stopShort: number, margin = CLEAR_MARGIN): boolean {
  const stopping = (v: { v: number; driver: { b: number } }): number => (v.v * v.v) / (2 * Math.max(1e-3, v.driver.b)) + margin;
  for (const body of w.bodiesIn(lanelet)) {
    const rear = body.s - body.vehicle.archetype.length;
    if (rear < to + margin && body.s > from - stopShort - stopping(body.vehicle)) return false;
  }
  // DO NOT walk `w.vehicles` for them
  const near = new Set<LaneletId>();
  for (const before of lanesInto(w, lanelet)) {
    near.add(before);
    for (const further of lanesInto(w, before)) near.add(further);
  }
  near.delete(lanelet);
  for (const id of near) {
    for (const vid of w.rt(id).order) {
      const v = w.veh(vid);
      if (!v || v.lanelet === lanelet) continue;
      const k = v.route.indexOf(lanelet);
      if (k <= 0 || k > 2) continue;
      let ahead = -v.s;
      for (let j = 0; j < k; j++) ahead += w.lanelet(v.route[j]!)?.length ?? 0;
      if (ahead + from - stopShort < stopping(v)) return false;
    }
  }
  return true;
}

/** The lanes a vehicle enters `id` from: a connector's own approach, or the connectors into a link at its junction. */
function lanesInto(w: SimWorld, id: LaneletId): LaneletId[] {
  const lane = w.lanelet(id);
  if (!lane) return [];
  if (lane.kind === 'connector') return lane.fromLane === undefined ? [] : [lane.fromLane];
  if (lane.from === undefined) return [];
  const out: LaneletId[] = [];
  for (const cid of w.graph.junctions.get(lane.from)?.connectors ?? []) {
    const c = w.connector(cid);
    if (c && c.toLane === id) out.push(c.lanelet);
  }
  return out;
}
