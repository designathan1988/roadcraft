import { m } from '@world/units';
import type { DriverParams } from '../vehicles/driver';
import { safeSpeed, type Obstacle } from '../vehicles/idm';
import { nextSpeed } from './operational';

/** The standstill gap that physically stops a body: a hand's breadth, not the driver's preferred one. */
const PHYSICAL_GAP = m(0.1);

/** Separate the driver's preferred standing gap from physical stopping room. */
export function physicalSpeed(p: DriverParams, speed: number, wanted: number, acceleration: number,
  obstacles: readonly Obstacle[], dt: number): number {
  const comfort = nextSpeed(p, speed, wanted, acceleration, obstacles, dt);
  // DO NOT build a driver with the physical gap here: that was an object per vehicle with a hard obstacle, every tick.
  let limit = Infinity;
  for (const obstacle of obstacles) {
    if (obstacle.hard === false) continue;
    limit = Math.min(limit, safeSpeed(p, obstacle, dt, PHYSICAL_GAP));
  }
  return Math.min(comfort, limit);
}
