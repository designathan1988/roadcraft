/**
 * Single source of truth for every numeric tolerance in the engine.
 *
 * The V6 monolith scattered magic numbers across ~120 functions (`1e-5`, `2.2`,
 * `2.5`, `2.6`, `.86`, `.08`, ...), which is how two different trim formulas and
 * two different axis tolerances came to disagree. Nothing outside this file may
 * introduce a bare tolerance literal. Lengths are written in metres (`m`).
 */

import { m } from './units';

/** Generic floating-point slop for "are these the same point/number". */
export const EPS = 1e-9;

/** Geometric slop — below this (0.04 mm), two positions are one position. */
export const GEO_EPS = m(0.00004);

/**
 * Comparison slop for a quantity that has already been through arithmetic.
 *
 * Coarser than `EPS` on purpose: a distance that survived an offset, a trim and
 * a projection has accumulated error well past 1e-9, and comparing it at that
 * precision produces false negatives.
 */
export const COARSE_EPS = 1e-6;

/** Slop for a value derived by one or two operations rather than many. */
export const FINE_EPS = 1e-7;

/**
 * Guard against dividing by a quantity that is numerically zero.
 *
 * Not a comparison tolerance — a denominator floor. Naming it separately keeps
 * it from being "simplified" into `EPS`, which is four orders of magnitude
 * larger and would reject legitimately small divisors.
 */
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

/**
 * Max chordal deviation when flattening a curve, in world units (2 cm): a
 * curved road's kerb reads as a curve, not a row of facets, at street level.
 */
export const FLATTEN_TOL = m(0.02);

/**
 * Max chordal deviation when flattening an arc, in world units (8 mm). The
 * flattened ring is what the surface meshes are built from, so this is how
 * round a kerb return is drawn: at 6 cm a 3 m return came out in four facets.
 */
export const ARC_TOL = m(0.008);

/** Taper slope used where two collinear legs have different half-widths. */
export const TAPER_ANGLE = (12 * Math.PI) / 180;

/** Shortest ribbon (drawn road body) we will ever emit: 20 cm. */
export const MIN_RIBBON = m(0.2);

/** How far a ribbon overlaps into its junction so nonzero fill hides the seam: 10 cm. */
export const SEAM_OVERLAP = m(0.1);

/**
 * Extra end extension per nested surface level.
 *
 * At a dead end, equal-length nested rings make every band contain a "hole"
 * whose end edge lies exactly on its outer boundary. That shape is valid to a
 * polygon clipper but ambiguous to a triangulator: on long diagonal roads
 * Earcut can bridge the touching hole across the carriageway and cover the
 * asphalt with footway triangles. Extending each inner level by this invisible
 * amount opens the band at the road end, leaving two ordinary side strips.
 */
export const SURFACE_END_STEP = m(0.00004);

export const TAU = Math.PI * 2;

/**
 * `a / b` read to a millionth, for a count rounded from it (bays along a
 * wall, posts along a run): two lengths in a whole ratio's middle (3.5 bays)
 * divide to 3.4999999999999996 or 3.5000000000000004 with the unit, and the
 * count came out one more or one fewer.
 */
export const steadyRatio = (a: number, b: number): number => Math.round((a / b) * 1e6) / 1e6;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Two-argument hypotenuse, for inner loops.
 *
 * `Math.hypot` is variadic: it scaled every argument by the largest, for
 * overflow safety, which costs about 3.4x `sqrt(x*x + y*y)` (measured, V8,
 * 5M calls). In the per-person and per-vehicle loops that runs per tick that
 * difference is a real share of the frame, and every caller here passes two
 * arguments of ordinary magnitude. `Math.hypot` stays the right call where the
 * arguments are not nearby (a wire in metres against a world coordinate in
 * thousands) or where the extra accuracy is the point.
 */
export const hypot2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wraps an angle into (-PI, PI]. */
export function normalizeAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}
