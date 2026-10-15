/** Single source of truth for every numeric tolerance in the engine. */

import { m } from './units';

/** Generic floating-point slop for "are these the same point/number". */
export const EPS = 1e-9;

/** Geometric slop — below this (0.04 mm), two positions are one position. */
export const GEO_EPS = m(0.00004);

/** Comparison slop for a quantity that has already been through arithmetic. */
export const COARSE_EPS = 1e-6;

/** Slop for a value derived by one or two operations rather than many. */
export const FINE_EPS = 1e-7;

/** Guard against dividing by a quantity that is numerically zero. */
export const DIV_EPS = 1e-12;

/** Floor on an iteration step, so a degenerate case cannot loop forever. */
export const MIN_ITER_STEP = 1e-3;

/** |sin(angle)| below this means two directions are parallel (~3 degrees). */
export const SIN_EPS = Math.sin((3 * Math.PI) / 180);

/** Wedge angles below this are "acute" and fall back to a bevel (~12 degrees). */
export const ACUTE_EPS = (12 * Math.PI) / 180;

/** Offset miter is clamped to this multiple of the offset distance. */
export const MITER_LIMIT = 4;

/** Junction corner miter limit, as a multiple of the larger half-width. */
export const CORNER_MITER = 2.5;

/** Max chordal deviation when flattening a curve, in world units (2 cm) */
export const FLATTEN_TOL = m(0.02);

/** Max chordal deviation when flattening an arc, in world units (8 mm). */
export const ARC_TOL = m(0.008);

/** Taper slope used where two collinear legs have different half-widths. */
export const TAPER_ANGLE = (12 * Math.PI) / 180;

/** Shortest ribbon (drawn road body) we will ever emit: 20 cm. */
export const MIN_RIBBON = m(0.2);

/** How far a ribbon overlaps into its junction so nonzero fill hides the seam: 10 cm. */
export const SEAM_OVERLAP = m(0.1);

/** Extra end extension per nested surface level. */
export const SURFACE_END_STEP = m(0.00004);

const TAU = Math.PI * 2;

/** `a / b` read to a millionth, for a count rounded from it (bays along a wall, posts along a run) */
export const steadyRatio = (a: number, b: number): number => Math.round((a / b) * 1e6) / 1e6;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Two-argument hypotenuse, for inner loops. */
export const hypot2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wraps an angle into (-PI, PI]. */
export function normalizeAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}
