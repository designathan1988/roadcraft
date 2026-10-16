import { kmh, m } from '@world/units';

/** Every tunable of the simulation, in world units and seconds. */

/** Fixed simulation step (`dt.ts`, a module of its own for the people's cook). */
export { DT } from './dt';
/** Cap on catch-up steps per frame, so a stall cannot spiral. */
export const MAX_SUBSTEPS = 5;
/** Wall-clock time is clamped to this before being accumulated. */
export const MAX_FRAME = 0.25;

/** A lane change is a PATH, not a slide. */
const LANE_CHANGE_HEADING_SLOW = 0.42;
const LANE_CHANGE_HEADING_FAST = 0.1;
/** Speed at which the shallow heading is reached, world units a second. */
const LANE_CHANGE_FAST_SPEED = kmh(45);
/** Never quicker than this at any speed, seconds. */
const LANE_CHANGE_MIN_TIME = 2;
/** Shortest curve, in body lengths of the vehicle driving it. */
const LANE_CHANGE_MIN_BODIES = 2.5;
/** Peak slope of the quintic profile, as a multiple of its mean slope. */
const PROFILE_PEAK = 1.875;

/** Road length over which a lane change of offset `start` is driven at `speed`. */
export function laneChangeLength(start: number, speed: number, bodyLength: number): number {
  const t = Math.min(1, Math.max(0, speed / LANE_CHANGE_FAST_SPEED));
  const heading = LANE_CHANGE_HEADING_SLOW + (LANE_CHANGE_HEADING_FAST - LANE_CHANGE_HEADING_SLOW) * t;
  return Math.max(PROFILE_PEAK * Math.abs(start) / Math.tan(heading),
    Math.max(0, speed) * LANE_CHANGE_MIN_TIME, bodyLength * LANE_CHANGE_MIN_BODIES, 1e-6);
}

/** Offset still to cover after driving `travelled` of a `length` change (quintic). */
export function laneChangeOffset(start: number, travelled: number, length: number): number {
  const u = Math.min(1, Math.max(0, travelled / length));
  const done = u * u * u * (10 - 15 * u + 6 * u * u);
  return u >= 1 ? 0 : start * (1 - done);
}

/** Sideways offset gained per unit of road driven: the tangent of the body's heading. */
export function laneChangeSlope(start: number, travelled: number, length: number): number {
  const u = Math.min(1, Math.max(0, travelled / length));
  if (u >= 1) return 0;
  return (-start * 30 * u * u * (1 - u) * (1 - u)) / length;
}

/** Bumper-to-bumper spacing at a standstill. */
export const JAM_GAP = m(2);
/** Longest vehicle in the fleet, used to size link capacity. */
const MAX_VEHICLE_LENGTH = m(9.8);
/** Shortest link that can hold the largest vehicle plus its jam gap. */
export const L_MIN = MAX_VEHICLE_LENGTH + JAM_GAP + m(2);

/** A vehicle requests entry from this far back — generous by design. */
export const REQUEST_TIME = 3.0;
export const REQUEST_MIN_DISTANCE = m(8);

/** Speed above which a vehicle counts as rolling rather than queueing. */
export const CONVOY_ROLLING = m(0.2);

/** Critical gaps for yielding movements, in seconds. */
export const CRITICAL_GAP = {
  through: 4.5,
  right: 4.0,
  left: 5.5,
  uturn: 6.5,
} as const;

/** Waiting drivers accept smaller gaps, but never below the floor. */
export const IMPATIENCE_RATE = 0.06;
export const IMPATIENCE_MAX = 1.5;
export const CRITICAL_GAP_FLOOR = 3.0;

/** Seconds a driver may wait for a gap before taking the next one offered. */
export const WAIT_CEILING = 12;

/** Signal timing, in seconds. */
export const SIGNAL = {
  minGreen: 6,
  // The widest built-in boulevard crossing is about 55 world units.
  baseGreen: 20,
  maxGreen: 34,
  /** Target green of an exclusive stage serving turns that are otherwise permissive. */
  exclusiveGreen: 10,
  amber: 3.2,
  minAllRed: 1.2,
  /** A group red for longer than this many cycles is promoted. */
  starvationCycles: 1.5,
  /** Uncontrolled nodes hold a permanent green. */
  uncontrolledGreen: 3600,
} as const;

/** Pedestrian parameters. */
export const PED = {
  /** Design speed used to size clearance intervals. */
  designSpeed: m(1.0),
  meanSpeed: m(1.34),
  speedSd: m(0.2),
  minSpeed: m(0.8),
  maxSpeed: m(1.8),
  /** Reaction lag before stepping off the kerb. */
  startLag: 1.0,
  /** Following model. */
  jamGap: m(0.45),
  headway: 0.4,
  accel: m(1.2),
  /** Parallel walking files across a crossing. */
  files: 3,
  fileSpacing: m(0.7),
  criticalGap: 4.0,
  /** Probability a driver yields to a waiting pedestrian at an uncontrolled crossing. */
  courtesyYield: 0.35,
} as const;

/** Vehicle population target, per unit of total road length. */
export const TRAFFIC_DENSITY = 1 / m(45);

/** Safety ceilings on the agent population. */
// They are ALSO what the renderer sizes its instance buffers from
export const FLEET_CEILING = 1200;
export const PED_CEILING = 1000;

/** Share of the ceiling allowed on a narrow screen. */
export const NARROW_SCREEN_SHARE = 0.5;
/** Viewport width, CSS pixels, under which a screen counts as narrow. */
export const NARROW_SCREEN_WIDTH = 800;

/** A claim holder immobile for this long is reported (diagnostic only). */
export const STUCK_SECONDS = 10;

/** Free-flow speed sampling. */
export const DRIVER_NOISE = { lo: 0.92, hi: 1.08 } as const;

/** Speed cap through curvature, expressed as the lateral acceleration a driver accepts, which FALLS with speed. */
export const MAX_LATERAL_ACCEL = m(4.0);
/** Reduction of the accepted lateral acceleration per unit of speed, per second. */
export const LATERAL_ACCEL_FALL = 0.09;
export const MIN_LATERAL_ACCEL = m(1.8);
