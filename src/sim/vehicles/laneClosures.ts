import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import type { SimWorld } from '../world';

/**
 * Stretches of lane closed for a while by something off the lanes standing
 * on them: a lorry swinging across the street into a works' gate, or out of
 * it (`agents/lorryTraffic.ts`). The traffic stops short of a closed stretch
 * as it stops short of a level crossing whose barriers are down
 * (`transit.closedOn`, read in `obstacles.ts`), and goes on when it opens:
 * the drivers wait while the lorry turns, as they do in a street.
 *
 * Whoever closes a stretch first makes sure nobody is on it nor too near to
 * stop (`laneClear`), and opens it again when done (`openLanes`).
 */
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

/** Every closure dropped (a new map). */
export function clearClosures(w: SimWorld): void {
  CLOSED.delete(w);
}

/** Kept between a closed stretch and the nearest body on it or past it. */
const CLEAR_MARGIN = m(2);

/**
 * Whether a stretch of lane may be closed now: no body on it, and nobody
 * coming along it, or along the lanes into it, too near to stop short of it
 * in comfort (`CLOSURE_STOP` before it, `obstacles.ts`).
 */
export function laneClear(w: SimWorld, lanelet: LaneletId, from: number, to: number, stopShort: number, margin = CLEAR_MARGIN): boolean {
  const stopping = (v: { v: number; driver: { b: number } }): number => (v.v * v.v) / (2 * Math.max(1e-3, v.driver.b)) + margin;
  for (const body of w.bodiesIn(lanelet)) {
    const rear = body.s - body.vehicle.archetype.length;
    if (rear < to + margin && body.s > from - stopShort - stopping(body.vehicle)) return false;
  }
  for (const v of w.vehicles.values()) {
    if (v.lanelet === lanelet) continue;
    const k = v.route.indexOf(lanelet);
    if (k <= 0 || k > 2) continue;
    let ahead = -v.s;
    for (let j = 0; j < k; j++) ahead += w.lanelet(v.route[j]!)?.length ?? 0;
    if (ahead + from - stopShort < stopping(v)) return false;
  }
  return true;
}
