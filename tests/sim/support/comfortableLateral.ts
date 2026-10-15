import { HEAVY, bodyClassOf } from '@world/conflictPoints';
import { LATERAL_ACCEL_FALL, MAX_LATERAL_ACCEL, MIN_LATERAL_ACCEL } from '@sim/params';
import type { Vehicle } from '@sim/vehicles/state';

/** Share of the comfortable lateral acceleration a heavy vehicle uses (as `sim/vehicles/curvature.ts`). */
const HEAVY_SHARE = 0.7;
/** Spread of comfortable lateral acceleration across drivers, per unit of aggression (as `sim/vehicles/curvature.ts`). */
const AGGRESSION_SPREAD = 0.2;

/**
 * The lateral acceleration this driver is comfortable with at `speed`, world
 * units per second squared: the figure `curveSpeedCap` is held to.
 */
export function comfortableLateral(v: Vehicle, speed = 0): number {
  const heavy = bodyClassOf(v.archetype.length, v.archetype.width) === HEAVY;
  const share = (1 + AGGRESSION_SPREAD * v.driver.aggression) * (heavy ? HEAVY_SHARE : 1);
  return share * Math.max(MIN_LATERAL_ACCEL, MAX_LATERAL_ACCEL - LATERAL_ACCEL_FALL * speed);
}
