import type { SimWorld } from '@sim/world';
import type { Vehicle } from '@sim/vehicles/state';
import { DT } from '@sim/params';
import { m } from '@world/units';
import { newFrame } from '@core/polyline';

/** What a vehicle is signalling and how its wheels sit, read straight off the simulation. */

/** +1 indicating left, -1 right, 0 none — in the vehicle's own frame. */
export type IndicatorSide = -1 | 0 | 1;

/** Offset of a lane change under which the manoeuvre is treated as finished. */
const LANE_CHANGE_DONE = 0.15;
/** A driver signals a turn this long, or this far, before the stop line. */
const TURN_SIGNAL_TIME = 4;
const TURN_SIGNAL_MIN = m(25);
/** And keeps signalling until this share of the turn is driven. */
const TURN_SIGNAL_UNTIL = 0.6;
/** Flash rate of an indicator, Hz, and the share of each flash that is lit. */
export const BLINK_HZ = 1.5;
const BLINK_DUTY = 0.55;
/** Largest front-wheel steering angle drawn, radians. */
export const MAX_STEER = 0.6;

/** Which way a vehicle is signalling. */
/** What `indicatorSide` reads of the two lanes, made once. */
const HERE = newFrame();
const THERE = newFrame();
const HIT = { s: 0, distance: 0 };

export function indicatorSide(w: SimWorld, v: Vehicle): IndicatorSide {
  if (Math.abs(v.lateral) > LANE_CHANGE_DONE) return v.lateral > 0 ? -1 : 1;

  const here = w.lanelet(v.lanelet);
  if (!here) return 0;

  const wanted = v.laneIntent ?? (v.desiredLane !== v.lanelet ? v.desiredLane : null);
  if (wanted) {
    const target = w.lanelet(wanted);
    if (target && here.kind === 'link') {
      // Into frames made once: every vehicle signalling a lane change, every frame drawn.
      const frame = here.centre.sampleAtInto(Math.min(Math.max(0, v.s), here.length), HERE);
      target.centre.closestInto(frame.p.x, frame.p.y, HIT);
      const at = target.centre.sampleAtInto(HIT.s, THERE).p;
      const leftward = (at.x - frame.p.x) * -frame.t.y + (at.y - frame.p.y) * frame.t.x;
      if (Math.abs(leftward) > 1e-6) return leftward > 0 ? 1 : -1;
    }
  }

  if (here.kind === 'connector') {
    if (v.s / Math.max(here.length, 1e-6) < TURN_SIGNAL_UNTIL) return turnSide(here.turn);
    return 0;
  }

  const toLine = here.length - v.s;
  if (toLine > Math.max(TURN_SIGNAL_MIN, v.v * TURN_SIGNAL_TIME)) return 0;
  for (const id of v.route) {
    if (id === v.lanelet) continue;
    const next = w.lanelet(id);
    if (!next) break;
    if (next.kind === 'connector') return turnSide(next.turn);
    break;
  }
  return 0;
}

function turnSide(turn: string | undefined): IndicatorSide {
  if (turn === 'left' || turn === 'uturn') return 1;
  if (turn === 'right') return -1;
  return 0;
}

/** Whether a flashing indicator is lit at this moment of the vehicle's life. */
export function blinkOn(age: number, id: number): boolean {
  const phase = ((id * 0.618034) % 1 + age * BLINK_HZ) % 1;
  return phase < BLINK_DUTY;
}

/** Front-wheel steering angle, radians, positive to the left. */
export function steerAngle(w: SimWorld, v: Vehicle, wheelbase: number): number {
  return steerFrom(pathCurvature(w, v), wheelbase);
}

/** Front-wheel steering angle for a path's curvature (`pathCurvature`) and a wheelbase: what the page draws from the worker's numbers. */
export function steerFrom(curvature: number, wheelbase: number): number {
  if (wheelbase <= 0) return 0;
  return Math.max(-MAX_STEER, Math.min(MAX_STEER, Math.atan(wheelbase * curvature)));
}

/** Curvature of the path the vehicle is driving under its front axle, per world unit, positive turning left */
/** The two tangents `pathCurvature` reads: made once (every vehicle drawn, every frame). */
const BEFORE = newFrame();
const AFTER = newFrame();

export function pathCurvature(w: SimWorld, v: Vehicle): number {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return 0;
  const span = Math.min(m(2), lane.length / 2);
  const s = Math.min(Math.max(v.s, span), lane.length - span);
  let curvature = 0;
  if (span > 1e-3) {
    const a = lane.centre.sampleAtInto(s - span, BEFORE).t;
    const b = lane.centre.sampleAtInto(s + span, AFTER).t;
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    curvature = turn / (2 * span);
  }
  const travelled = v.s - (v.prev.lanelet === v.lanelet ? v.prev.s : v.s);
  if (travelled > 1e-4) {
    curvature += (Math.atan(v.lateralSlope) - Math.atan(v.prev.lateralSlope)) / travelled;
  }
  return curvature;
}

/** Distance each vehicle has driven, for the rolling angle of its wheels. */
export class WheelOdometer {
  private readonly seen = new WeakMap<Vehicle, { lanelet: string; s: number; total: number }>();

  /** Total distance driven so far, in world units. */
  advance(v: Vehicle): number {
    const last = this.seen.get(v);
    if (!last) {
      this.seen.set(v, { lanelet: v.lanelet, s: v.s, total: 0 });
      return 0;
    }
    const ds = last.lanelet === v.lanelet ? v.s - last.s : Math.max(0, v.v) * DT;
    last.total += Math.max(0, ds);
    last.lanelet = v.lanelet;
    last.s = v.s;
    return last.total;
  }
}
