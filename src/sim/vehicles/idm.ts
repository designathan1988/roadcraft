import { clamp } from '@core/scalar';
import { m } from '@world/units';
import type { DriverParams } from './driver';

/** Anything a vehicle must not run into */
export interface Obstacle {
  /** Bumper-to-bumper distance ahead. May be clamped to a small positive. */
  readonly gap: number;
  /** Speed of the obstacle; zero for anything stationary. */
  readonly speed: number;
  readonly kind: ObstacleKind;
  /** Excluded from the hard safe-speed cap when false. */
  readonly hard?: boolean | undefined;
  /** Its acceleration, when it is a vehicle: what it is doing, not just how fast. */
  readonly accel?: number | undefined;
}

export type ObstacleKind =
  | 'vehicle'
  | 'signal'
  | 'conflict'
  | 'pedestrian'
  | 'spillback'
  | 'yield'
  | 'endOfRoute'
  | 'curvature'
  | 'kerbStop';

/** An obstacle the set owns and may write again (its fields as the set reads them). */
export interface MutableObstacle {
  gap: number;
  speed: number;
  kind: ObstacleKind;
  hard?: boolean | undefined;
  accel?: number | undefined;
}

export interface ConstraintSet {
  obstacles: Obstacle[];
  /** The obstacle written at each place this tick, kept from the ticks before: an obstacle a vehicle does not carry a tick (a leader, a signal) is written in the same object, never a new one. */
  readonly pool: MutableObstacle[];
  /** How many of `pool` this tick's obstacles take (`resetConstraints` puts it back to none). */
  used: number;
}

export const emptyConstraints = (): ConstraintSet => ({ obstacles: [], pool: [], used: 0 });

/** The set emptied for a tick: its slots kept (nothing made), and nothing of the tick before left in the list. */
export function resetConstraints(c: ConstraintSet): void {
  c.obstacles.length = 0;
  c.used = 0;
}

/** The next slot of the set, its object made once and written again at every tick: DO NOT make an obstacle a vehicle a tick (hundreds a tick, every tick). */
export function nextObstacle(c: ConstraintSet): MutableObstacle {
  const at = c.used++;
  let o = c.pool[at];
  if (!o) c.pool[at] = o = { gap: 0, speed: 0, kind: 'signal' };
  return o;
}

/** An obstacle written into one of the set's slots and appended: the fields it does not carry left undefined (not the last tick's). */
export function addObstacle(c: ConstraintSet, gap: number, speed: number, kind: ObstacleKind, accel?: number, hard?: boolean): void {
  const o = nextObstacle(c);
  o.gap = gap; o.speed = speed; o.kind = kind;
  o.accel = accel; o.hard = hard;
  c.obstacles.push(o);
}

/** `out` filled as the found obstacle, or a new one when the caller keeps none (`findLeader` without a set): what a finder writes its winner into. */
export function obstacleInto(out: MutableObstacle | null | undefined, gap: number, speed: number, kind: ObstacleKind, accel?: number, hard?: boolean): Obstacle {
  const o: MutableObstacle = out ?? { gap: 0, speed: 0, kind };
  o.gap = gap; o.speed = speed; o.kind = kind;
  o.accel = accel; o.hard = hard;
  return o;
}

/** Follower speed by which the queue-release response has faded out, world units a second. */
const RELEASE_FADE = m(4);
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Intelligent Driver Model acceleration for one obstacle. */
export function idmAccel(p: DriverParams, v: number, v0: number, o: Obstacle): number {
  const dv = v - o.speed;
  // A stopped queue needs a small release response once its direct leader is moving.
  const releasing = o.kind === 'vehicle' && o.speed > m(0.1) && v < o.speed + m(0.8)
    ? 1 - smooth(v / RELEASE_FADE)
    : 0;
  const standstill = p.s0 * (1 - 0.6 * releasing);
  const headway = p.T * (1 - 0.6 * releasing);
  const sStar = standstill + Math.max(0, v * headway + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const s = Math.max(o.gap, m(0.02));
  return p.a * (1 - Math.pow(v / Math.max(v0, 0.01), 4) - (sStar / s) ** 2);
}

/** Highest speed from which this vehicle can still stop short of the obstacle */
export function safeSpeed(p: DriverParams, o: Obstacle, dt: number, s0: number = p.s0): number {
  const b = p.bEmergency;
  const leadStopping = o.speed > 0 ? (o.speed * o.speed) / (2 * b) : 0;
  const room = Math.max(0, o.gap - s0 + leadStopping);
  return Math.max(0, -b * dt + Math.sqrt(b * b * dt * dt + 2 * b * room));
}

/** True when the vehicle can still stop before `d` without harsh braking. */
export const canStopComfortably = (p: DriverParams, v: number, d: number): boolean =>
  (v * v) / (2 * p.b) <= d;
