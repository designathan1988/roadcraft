import { clamp } from '@core/scalar';
import { m } from '@world/units';
import type { DriverParams } from '../vehicles/driver';
import type { Obstacle } from '../vehicles/idm';

/** DRIVE v2, OPERATIONAL: how hard to press the pedals this tick. */

/** IDM acceleration exponent. */
const DELTA = 4;
/** Share of the heuristic in the blend (Treiber & Kesting use 0.99). */
const COOLNESS = 0.99;
/** Fastest a driver's acceleration rises (easing on), and falls (braking harder), u/s³. */
export const JERK_UP = m(2.5);
const JERK_DOWN = m(8);
/** Below this a driver lifts off at once. */
const CRAWL = m(1);

/** Improved IDM against one obstacle, and the free-road term. */
function iidm(p: DriverParams, v: number, v0: number, o: Obstacle | null): number {
  const v0s = Math.max(v0, 0.01);
  const free = v <= v0s
    ? p.a * (1 - Math.pow(v / v0s, DELTA))
    : -p.b * (1 - Math.pow(v0s / v, (p.a * DELTA) / p.b));
  if (!o) return free;
  const dv = v - o.speed;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const z = sStar / Math.max(o.gap, m(0.02));
  if (v <= v0s) return z >= 1 ? p.a * (1 - z * z) : free * (1 - Math.pow(z, (2 * p.a) / Math.max(free, 1e-6)));
  return z >= 1 ? free + p.a * (1 - z * z) : free;
}

/** The Constant-Acceleration Heuristic: braking needed if the obstacle keeps its acceleration. */
function cah(p: DriverParams, v: number, o: Obstacle): number {
  // What the car ahead is doing, as a driver can read it: never harder than an emergency stop.
  const al = clamp(o.accel ?? 0, -p.bEmergency, p.a);
  const vl = o.speed;
  const s = Math.max(o.gap, m(0.02));
  if (vl * (v - vl) <= -2 * s * al) return (v * v * al) / Math.max(vl * vl - 2 * s * al, 1e-6);
  const closing = Math.max(0, v - vl);
  return al - (closing * closing) / (2 * s);
}

/** Adaptive Cruise Control acceleration against one obstacle. */
function accAccel(p: DriverParams, v: number, v0: number, o: Obstacle): number {
  const aIidm = iidm(p, v, v0, o);
  const aCah = cah(p, v, o);
  if (aIidm >= aCah) return aIidm;
  return (1 - COOLNESS) * aIidm + COOLNESS * (aCah + p.b * Math.tanh((aIidm - aCah) / p.b));
}

/** The next speed and the acceleration that produced it. */
export function nextSpeed(p: DriverParams, v: number, v0: number, lastAccel: number,
  obstacles: readonly Obstacle[], dt: number): number {
  let target = iidm(p, v, v0, null);
  // Above the wanted speed (a slower stretch just entered, a turn), it is shed at a comfortable deceleration
  const cap = Math.max(v0, v - p.b * dt);
  for (const o of obstacles) {
    target = Math.min(target, accAccel(p, v, v0, o));
  }
  target = clamp(target, -p.bEmergency, p.a);
  // From what the driver's foot was doing, which is never harder than an emergency stop
  const foot = clamp(lastAccel, -p.bEmergency, p.a);
  // Easing on, and ordinary braking, change at a driver's pace; braking beyond comfortable is not held back
  const a = target < -p.b || (v < CRAWL && target < foot) ? Math.min(target, foot + JERK_UP * dt)
    : clamp(target, foot - JERK_DOWN * dt, foot + JERK_UP * dt);
  // The speed alone, never an object per vehicle and tick: the acceleration is what the caller derives from it
  return clamp(v + a * dt, 0, Math.max(0, cap));
}
