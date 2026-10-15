import { m } from '@world/units';
import type { Lanelet } from '@world/lanelets';
import { HEAVY, bodyClassOf } from '@world/conflictPoints';
import { LATERAL_ACCEL_FALL, MAX_LATERAL_ACCEL, MIN_LATERAL_ACCEL } from '../params';
import { JERK_UP } from '../drive/operational';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';

/** How fast a driver is willing to take the road ahead, from its curvature. */

/** Spacing of the curvature profile along a lanelet. */
const SAMPLE = m(2);
/** Half-length of the chord the curvature is measured over. */
const CHORD = m(3);
/** Share of the comfortable lateral acceleration a heavy vehicle uses. */
const HEAVY_SHARE = 0.7;
/** Spread of comfortable lateral acceleration across drivers, per unit of aggression. */
const AGGRESSION_SPREAD = 0.2;
/** Look-ahead beyond the braking distance, seconds of travel plus a margin. */
const LOOK_TIME = 1.5;
const LOOK_MARGIN = m(10);

const profiles = new WeakMap<Lanelet, Float32Array>();
/** Each profile's sharpest sample: below `STRAIGHT` the whole lanelet is straight. */
const peaks = new WeakMap<Lanelet, number>();
/** Curvature taken as none at all. */
const STRAIGHT = 1e-6;

/** Curvature, per world unit, at each `SAMPLE` along the lanelet. */
function profileOf(lane: Lanelet): Float32Array {
  const cached = profiles.get(lane);
  if (cached) return cached;
  const n = Math.max(1, Math.ceil(lane.length / SAMPLE) + 1);
  const out = new Float32Array(n);
  const h = Math.min(CHORD, lane.length / 2);
  let peak = 0;
  if (h > 1e-3) {
    for (let i = 0; i < n; i++) {
      const s = Math.min(Math.max(i * SAMPLE, h), lane.length - h);
      const a = lane.centre.sampleAt(s - h).t;
      const b = lane.centre.sampleAt(s + h).t;
      out[i] = Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) / (2 * h);
      peak = Math.max(peak, out[i]!);
    }
  }
  profiles.set(lane, out);
  peaks.set(lane, peak);
  return out;
}

/** Whether a lanelet has no bend anywhere (its profile made first if need be). */
function straight(lane: Lanelet): boolean {
  profileOf(lane);
  return peaks.get(lane)! < STRAIGHT;
}

/** Share of the fleet-wide figure this driver accepts: personality and vehicle. */
function lateralShare(v: Vehicle): number {
  const heavy = bodyClassOf(v.archetype.length, v.archetype.width) === HEAVY;
  return (1 + AGGRESSION_SPREAD * v.driver.aggression) * (heavy ? HEAVY_SHARE : 1);
}

/** Fastest speed at which a bend of curvature `k` is taken within the driver's speed-dependent comfort */
function bendSpeed(share: number, k: number): number {
  const a0 = share * MAX_LATERAL_ACCEL;
  const c = share * LATERAL_ACCEL_FALL;
  const v = (-c + Math.sqrt(c * c + 4 * k * a0)) / (2 * k);
  const floor = Math.sqrt((share * MIN_LATERAL_ACCEL) / k);
  return Math.max(v, floor);
}

/** The speed this vehicle takes the sharpest bend of a lanelet at, within its comfort. */
export function slowestBend(v: Vehicle, lane: Lanelet): number {
  const share = lateralShare(v);
  let slowest = Infinity;
  for (const k of profileOf(lane)) {
    if (k < 1e-6) continue;
    slowest = Math.min(slowest, bendSpeed(share, k));
  }
  return slowest;
}

/** Highest speed at which this vehicle can drive on now and still take every bend within its look-ahead at a comfortable */
export function curveSpeedCap(w: SimWorld, v: Vehicle): number {
  const share = lateralShare(v);
  const brake = Math.max(v.driver.b, 1e-3);
  const horizon = (v.v * v.v) / (2 * brake) + v.v * LOOK_TIME + LOOK_MARGIN;
  let cap = Infinity;
  // The brake comes off as a ramp, not at once: the pedal changes at a driver's jerk
  const easeTime = brake / JERK_UP;
  const eased = (brake * brake) / (2 * JERK_UP);
  /** Highest speed `d` ahead of a bend taken at `safe`: braking, then the ramp easing off. */
  const before = (safe: number, d: number): number => {
    const top = safe + eased;
    const ramp = Math.max(1e-6, top * easeTime - (brake * brake * brake) / (3 * JERK_UP * JERK_UP));
    return d <= ramp ? safe + eased * (d / ramp) : Math.sqrt(top * top + 2 * brake * (d - ramp));
  };

  // The body itself, from its middle to its front at distance 0, then ahead of the front along the planned route.
  let lane = w.lanelet(v.lanelet);
  let from = v.s - v.archetype.length / 2;
  let ahead = -v.s; // distance from the front to the start of `lane`
  let next = 0;
  while (lane && ahead < horizon) {
    // A straight lanelet - most of a town's - has no sample that could lower the cap
    if (!straight(lane)) {
      const profile = profileOf(lane);
      const start = Math.max(0, Math.floor(Math.max(0, from) / SAMPLE));
      for (let i = start; i < profile.length; i++) {
        const s = i * SAMPLE;
        const d = Math.max(0, ahead + s);
        if (d > horizon) break;
        const k = profile[i]!;
        if (k < STRAIGHT) continue;
        cap = Math.min(cap, before(bendSpeed(share, k), d));
      }
    }
    ahead += lane.length;
    from = 0;
    // The route lists the current lanelet first.
    let id = v.route[++next];
    while (id === lane.id) id = v.route[++next];
    lane = id ? w.lanelet(id) : undefined;
  }
  return cap;
}
