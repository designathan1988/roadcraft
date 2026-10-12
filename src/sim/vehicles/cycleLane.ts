import type { Lanelet } from '@world/lanelets';
import { m } from '@world/units';
import type { Vehicle } from './state';

/**
 * Bicycles in a cycle lane (ciclofaixa, `world/parking.ts` kind `cycle`).
 *
 * The cycle lane is a band of the carriageway beside the kerb-side travel
 * lane. As in SUMO's sublane model (sumo.dlr.de/docs/Simulation/Bicycles.html,
 * Simulation/SublaneModel.html), a bicycle on that lane rides at its side,
 * inside the red band, and the cars of the lane no longer follow it: they
 * pass it. Near either end of the link it eases back to the lane centre, so it
 * goes through the junction in the traffic, and there it is followed again.
 */

/** Distance at each end of a link over which a bicycle eases into and out of the cycle lane. */
export const CYCLE_EASE = m(8);

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
