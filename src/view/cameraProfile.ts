import { clamp } from '@core/scalar';
import { m } from '@core/units';

/** THE CAMERA'S SHAPE BY DISTANCE: how the perspective camera looks at the town as it comes closer */

/** The ground seen at and below which the view is a street view, world units. */
const NEAR_HALF = m(1.2);
/** The tilt the camera keeps at a far zoom: the angle the game was drawn for. */
export const FAR_TILT = (48 * Math.PI) / 180;
/** The tilt the camera eases to at the closest zoom: nearly level, a pedestrian's view. */
const NEAR_TILT = (6 * Math.PI) / 180;
/** The lowest tilt allowed far away (an overview never looks at the horizon) and close up (looking up at a facade). */
const FAR_MIN_TILT = (20 * Math.PI) / 180;
export const NEAR_MIN_TILT = (-30 * Math.PI) / 180;
/** The lens, vertical field of view in degrees: long far away, wider in the street. */
const FAR_FOV = 35;
const NEAR_FOV = 55;
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

/** How much of the pull in front of a building the camera takes at this distance, 0..1 (`render/isoViewport.ts`) */
export function pullWeight(halfHeight: number): number {
  return 1 - blend(halfHeight, NEAR_HALF * 4, NEAR_HALF * 16);
}

/** The camera's distance from the point it looks at, for the view to be `halfHeight` tall there. */
export function viewDistance(halfHeight: number): number {
  return halfHeight / Math.tan((fieldOfView(halfHeight) * Math.PI) / 360);
}
