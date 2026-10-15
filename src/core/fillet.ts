import { ACUTE_EPS, COARSE_EPS, EPS, SIN_EPS, clamp } from './scalar';
import { type Vec2, add, addScaled, dot, normalize } from './vec2';
import { m } from './units';

export interface Fillet {
  /** Tangency point on the `dirA` side. */
  readonly ta: Vec2;
  /** Tangency point on the `dirB` side. */
  readonly tb: Vec2;
  /** Arc centre. */
  readonly c: Vec2;
  /** Arc radius. */
  readonly r: number;
  /** Distance from the corner to each tangency. */
  readonly run: number;
}

/** Rounds the corner at `x` where the boundary leaves along `dirA` on one side and `dirB` on the other. */
export function filletCorner(
  x: Vec2,
  dirA: Vec2,
  dirB: Vec2,
  r: number,
): Fillet | null {
  if (r <= 0) return null;
  const psi = Math.acos(clamp(dot(dirA, dirB), -1, 1));
  if (psi < ACUTE_EPS) return null; // too sharp to round; bevel instead
  if (Math.PI - psi < SIN_EPS) return null; // straight through; nothing to round

  const half = psi / 2;
  const tanHalf = Math.tan(half);
  const sinHalf = Math.sin(half);
  if (tanHalf < EPS || sinHalf < EPS) return null;

  const run = r / tanHalf;
  const bis = normalize(add(dirA, dirB));

  return {
    ta: addScaled(x, dirA, run),
    tb: addScaled(x, dirB, run),
    c: addScaled(x, bis, r / sinHalf),
    r,
    run,
  };
}

/** Small relative clearance added to the acute setback. */
const ACUTE_CLEARANCE = 1.02;

/** Distance from the corner at which two rays separated by `psi`, carrying half-widths `hwA` and `hwB`, stop overlapping. */
export function acuteSetback(psi: number, hwA: number, hwB: number): number {
  const s = Math.sin(Math.max(psi, COARSE_EPS) / 2);
  return (ACUTE_CLEARANCE * (hwA + hwB)) / (2 * s);
}

/** Default curb-return radius for a corner between two half-widths. */
const CURB_R_MIN = m(2.8);

/** Widest return we will hand out: 7.2 m. */
export const CURB_R_MAX = m(7.2);

export function curbRadius(hwA: number, hwB: number): number {
  return clamp(0.5 * Math.min(hwA, hwB), CURB_R_MIN, CURB_R_MAX);
}
