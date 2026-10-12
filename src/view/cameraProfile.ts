import { clamp } from '@core/scalar';
import { m } from '@core/units';

/**
 * THE CAMERA'S SHAPE BY DISTANCE: how the perspective camera looks at the
 * town as it comes closer, one continuous function of how much ground the
 * view takes in (`halfHeight`, world units: half the height of the ground
 * seen at the centre of the view).
 *
 * Far away the town reads as a map: the default tilt (48 degrees), a long
 * lens, never lower than 20 degrees. Close up it reads as a street: the
 * tilt eases towards the horizon, the lens widens, the point looked at rises
 * to a person's eye height and the camera may look up at a facade. Each of
 * these is blended on the logarithm of `halfHeight`, as the wheel zooms by
 * factors, with a smoothstep, so no zoom step brings a jump (Google Earth's
 * and Cities: Skylines II's tilt with distance; the player, 2026-10-09:
 * "inclinação até próximo do nível da rua ... transição suave").
 *
 * Pure numbers, no three.js: the rig (`render/isoViewport.ts`) applies them,
 * the tests read them.
 */

/** The ground seen at and below which the view is a street view, world units. */
const NEAR_HALF = m(1.2);
/** The tilt the camera keeps at a far zoom: the angle the game was drawn for. */
export const FAR_TILT = (48 * Math.PI) / 180;
/** The tilt the camera eases to at the closest zoom: nearly level, a pedestrian's view. */
export const NEAR_TILT = (6 * Math.PI) / 180;
/** The lowest tilt allowed far away (an overview never looks at the horizon) and close up (looking up at a facade). */
export const FAR_MIN_TILT = (20 * Math.PI) / 180;
export const NEAR_MIN_TILT = (-30 * Math.PI) / 180;
/** The lens, vertical field of view in degrees: long far away, wider in the street. */
export const FAR_FOV = 35;
export const NEAR_FOV = 55;
/** A standing person's eyes, world units. */
export const EYE_HEIGHT = m(1.7);

/** 0 at `near` and below, 1 at `far` and above, smooth in between, on the logarithm of `halfHeight`. */
function blend(halfHeight: number, near: number, far: number): number {
  const t = clamp(Math.log(Math.max(1e-6, halfHeight) / near) / Math.log(far / near), 0, 1);
  return t * t * (3 - 2 * t);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The tilt the camera takes by itself at this distance, rad (the player's own tilt is added to it). */
export function profileTilt(halfHeight: number): number {
  return lerp(NEAR_TILT, FAR_TILT, blend(halfHeight, NEAR_HALF, m(80)));
}

/** The lowest tilt at this distance, rad: below zero close up, the camera under the point it looks at. */
export function minTilt(halfHeight: number): number {
  return lerp(NEAR_MIN_TILT, FAR_MIN_TILT, blend(halfHeight, NEAR_HALF * 2, m(48)));
}

/** How far over the ground the point looked at stands, world units: eye height in the street, the ground far away. */
export function eyeLift(halfHeight: number): number {
  return EYE_HEIGHT * (1 - blend(halfHeight, NEAR_HALF, m(12)));
}

/** The lens at this distance, degrees. */
export function fieldOfView(halfHeight: number): number {
  return lerp(NEAR_FOV, FAR_FOV, blend(halfHeight, NEAR_HALF, m(24)));
}

/**
 * How much of the pull in front of a building the camera takes at this
 * distance, 0..1 (`render/isoViewport.ts`): all of it in the street, where a
 * wall between the eye and the point looked at would fill the screen; none
 * from the rooftops out, where the overview must never be held among the
 * towers (a tower hiding a street behind it is how a city builder's
 * overview looks).
 */
export function pullWeight(halfHeight: number): number {
  return 1 - blend(halfHeight, NEAR_HALF * 4, NEAR_HALF * 16);
}

/** The camera's distance from the point it looks at, for the view to be `halfHeight` tall there. */
export function viewDistance(halfHeight: number): number {
  return halfHeight / Math.tan((fieldOfView(halfHeight) * Math.PI) / 360);
}
