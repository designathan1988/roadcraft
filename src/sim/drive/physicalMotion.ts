import { m } from '@world/units';
import type { DriverParams } from '../vehicles/driver';
import { safeSpeed, type Obstacle } from '../vehicles/idm';
import { nextSpeed } from './operational';

/**
 * Separate the driver's preferred standing gap from physical stopping room.
 * A newly denied movement inside that preferred gap must not instantaneously
 * stop the body while metres of collision-free braking room still remain.
 */
export function physicalSpeed(p: DriverParams, speed: number, wanted: number, acceleration: number,
  obstacles: readonly Obstacle[], dt: number): number {
  const comfort = nextSpeed(p, speed, wanted, acceleration, obstacles, dt).v;
  // The car-following parameters alone, with the physical gap, made only when
  // a hard obstacle needs them: spread from the driver, every vehicle copied
  // all of its personality into a fresh object every tick (MDN: a spread
  // copies every own enumerable property).
  let physical: DriverParams | null = null;
  let limit = Infinity;
  for (const obstacle of obstacles) {
    if (obstacle.hard === false) continue;
    physical ??= { a: p.a, b: p.b, bEmergency: p.bEmergency, T: p.T, s0: m(0.1) };
    limit = Math.min(limit, safeSpeed(physical, obstacle, dt));
  }
  return Math.min(comfort, limit);
}
