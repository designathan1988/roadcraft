import { clamp } from '@core/scalar';
import type { Archetype } from './archetypes';

/** The driver behind the wheel, as distinct from the vehicle around them. ## Why this exists Every sedan braked identically */

/** The subset of an archetype the longitudinal model actually reads. */
export interface DriverParams {
  /** Comfortable acceleration. */
  readonly a: number;
  /** Comfortable deceleration. */
  readonly b: number;
  /** Emergency deceleration, used by the safe-speed cap. */
  readonly bEmergency: number;
  /** Desired time headway, in seconds. */
  readonly T: number;
  /** Standstill gap. */
  readonly s0: number;
}

export interface Driver extends DriverParams {
  /** -1 timid, 0 ordinary, +1 pushy. */
  readonly aggression: number;
  /** Multiplies the critical gap a yielding movement demands. */
  readonly gapFactor: number;
  /** MOBIL politeness: how much this driver weighs the cars they affect. */
  readonly politeness: number;
  /** MOBIL threshold: the gain an overtake has to be worth. */
  readonly laneThreshold: number;
  /** Amplitude of the slow wander in desired speed, as a fraction. */
  readonly driftAmplitude: number;
  /** Angular rate of that wander, in radians per second. */
  readonly driftRate: number;
  /** Phase of it, so no two drivers wander together. */
  readonly driftPhase: number;
  /** Seconds of being held up before this driver looks for another way round. */
  readonly patience: number;
}

/** Spread of the comfort parameters between the timid and the pushy. */
const ACCEL_SPREAD = 0.3;
const BRAKE_SPREAD = 0.22;
const HEADWAY_SPREAD = 0.32;
const GAP_SPREAD = 0.28;
/** The emergency brake barely varies. */
const EMERGENCY_SPREAD = 0.025;

/** Draws a driver. */
export function makeDriver(archetype: Archetype, sample: () => number): Driver {
  // Two uniforms averaged: a triangular distribution, so most drivers are ordinary and the extremes are rare.
  const aggression = clamp((sample() + sample() - 1) * 1.15, -1, 1);

  return {
    aggression,
    a: archetype.a * (1 + aggression * ACCEL_SPREAD),
    b: archetype.b * (1 + aggression * BRAKE_SPREAD),
    bEmergency: archetype.bEmergency * (1 + aggression * EMERGENCY_SPREAD),
    // Inverted: the pushy driver keeps a SHORTER headway and a smaller gap.
    T: archetype.T * (1 - aggression * HEADWAY_SPREAD),
    s0: archetype.s0 * (1 - aggression * GAP_SPREAD * 0.6),
    gapFactor: 1 - aggression * GAP_SPREAD,
    // A polite driver gives more weight to the cars a lane change would inconvenience; a pushy one barely notices them.
    politeness: clamp(0.45 - aggression * 0.3, 0.05, 0.8),
    // And demands less of an improvement before taking the lane.
    laneThreshold: clamp(0.35 - aggression * 0.22, 0.08, 0.7),
    // Independent of aggression, because nobody holds an exact speed.
    driftAmplitude: 0.025 + sample() * 0.045,
    driftRate: 0.06 + sample() * 0.12,
    driftPhase: sample() * Math.PI * 2,
    patience: 6 + (1 - aggression) * 7,
  };
}

/** The speed this driver is aiming for right now. */
export function desiredSpeed(driver: Driver, v0: number, time: number): number {
  return v0 * (1 + driver.driftAmplitude * Math.sin(driver.driftPhase + time * driver.driftRate));
}
