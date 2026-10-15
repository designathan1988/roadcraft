import type { Lanelet } from '@world/lanelets';
import { m } from '@world/units';
import type { Vehicle } from './state';

/** Bicycles in a cycle lane (ciclofaixa, `world/parking.ts` kind `cycle`). */

/** Distance at each end of a link over which a bicycle eases into and out of the cycle lane. */
const CYCLE_EASE = m(8);

const isBicycle = (v: Vehicle): boolean => v.archetype.shape === 'bicycle';

/** 0 at the ends of the link, 1 along its middle. */
function inside(lane: Lanelet, centre: number): number {
  const d = Math.min(centre, lane.length - centre);
  if (d <= 0) return 0;
  if (d >= CYCLE_EASE) return 1;
  const t = d / CYCLE_EASE;
  return t * t * (3 - 2 * t);
}

/** Sideways shift of a bicycle's body at front arc `s` on `lane` (0 for anything else). */
export function cycleShift(v: Vehicle, lane: Lanelet | undefined, s: number): number {
  if (!lane?.cycleShift || !isBicycle(v)) return 0;
  return lane.cycleShift * inside(lane, s - v.archetype.length / 2);
}

/** True when `lead` rides in the cycle lane beside `follower`'s path, out of its way. */
export function outOfTheWay(follower: Vehicle, lead: Vehicle, lane: Lanelet | undefined): boolean {
  if (isBicycle(follower) || !isBicycle(lead) || !lane?.cycleShift || lane.id !== lead.lanelet) return false;
  // Clear of the lane once the body is most of the way into the band.
  return inside(lane, lead.s - lead.archetype.length) > 0.8 && inside(lane, lead.s) > 0.8;
}
