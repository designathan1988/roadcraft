import { ACUTE_EPS, COARSE_EPS, CORNER_MITER, SIN_EPS, TAPER_ANGLE, clamp } from '@core/scalar';
import { type Vec2, addScaled, dist, dot, sub } from '@core/vec2';
import { lineLine } from '@core/intersect';
import { CURB_R_MAX, acuteSetback, curbRadius, filletCorner, type Fillet } from '@core/fillet';
import { type Leg } from './legs';

type CornerMode = 'fillet' | 'bevel' | 'collinear' | 'taper';

export interface Corner {
  /** Index of the leg whose LEFT boundary feeds this corner. */
  readonly i: number;
  /** Index of the leg whose RIGHT boundary leaves this corner. */
  readonly j: number;
  readonly mode: CornerMode;
  /** Intersection of the two boundary lines. Null in collinear/taper mode. */
  readonly x: Vec2 | null;
  /** Wedge angle at `x`, in radians. */
  readonly psi: number;
  readonly fillet: Fillet | null;
  /** Trim contribution this corner demands of leg `i`. */
  readonly trimI: number;
  /** Trim contribution this corner demands of leg `j`. */
  readonly trimJ: number;
}

/** Resolves every corner of a junction. */
export function computeCorners(
  legs: readonly Leg[],
  radiusScale: readonly number[] = [],
  mouthTrims: readonly number[] = [],
): Corner[] {
  const n = legs.length;
  if (n < 2) return [];

  const corners: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    corners.push(resolveCorner(legs, i, j, radiusScale, mouthTrims));
  }
  return corners;
}

function resolveCorner(
  legs: readonly Leg[],
  i: number,
  j: number,
  radiusScale: readonly number[],
  mouthTrims: readonly number[],
): Corner {
  const a = legs[i] as Leg;
  const b = legs[j] as Leg;

  // Leg `a`'s left boundary and leg `b`'s right boundary, each at its own side's width
  const aw = a.hwLeft, bw = b.hwRight;
  const a0 = addScaled(a.origin, a.nrm, aw);
  const b0 = addScaled(b.origin, b.nrm, -bw);

  const psi = Math.acos(clamp(dot(a.dir, b.dir), -1, 1));
  const step = Math.abs(aw - bw);

  // --- A width step across a near-straight pair is a TAPER, not a corner. --- Keyed on the ANGLE
  if (step >= COARSE_EPS && Math.PI - psi < TAPER_ANGLE) {
    const taperRun = step / Math.tan(TAPER_ANGLE) / 2;
    return { i, j, mode: 'taper', x: null, psi, fillet: null, trimI: taperRun, trimJ: taperRun };
  }

  const hit = lineLine(a0, a.dir, b0, b.dir, SIN_EPS);

  // --- No corner point exists: the boundary lines are parallel. ------------ `lineLine` rejects on |cross(a.dir, b.dir)| <
  if (!hit) {
    // Anti-parallel: one road through the node.
    if (psi > Math.PI / 2) {
      if (step < COARSE_EPS) return collinear(i, j, psi, 0);
      const taperRun = step / Math.tan(TAPER_ANGLE) / 2;
      return { i, j, mode: 'taper', x: null, psi, fillet: null, trimI: taperRun, trimJ: taperRun };
    }
    // Same direction: a hairpin fork.
    return collinear(i, j, psi, acuteSetback(psi, aw, bw));
  }

  const x = hit.point;
  const reach = Math.max(dist(x, a.origin), dist(x, b.origin));
  const maxHw = Math.max(aw, bw);

  // --- Very acute wedge: rounding would run away, so bevel it. ------------- The setback is used EXACTLY
  const scale = clamp(Math.min(radiusScale[i] ?? 1, radiusScale[j] ?? 1), 0, 1);
  const scaled = curbRadius(a.hwSidewalk, b.hwSidewalk) * scale;

  if (psi < ACUTE_EPS || reach > CORNER_MITER * maxHw) {
    const t = acuteSetback(psi, aw, bw);

    // Round the setback instead of chording it.
    const rNeed = (t - Math.min(project(x, a), project(x, b))) * Math.tan(psi / 2);
    if (rNeed <= CURB_R_MAX) {
      // `filletCorner` refuses a wedge below `ACUTE_EPS`
      const rounded = filletCorner(x, a.dir, b.dir, Math.max(scaled, rNeed));
      if (rounded) {
        return {
          i,
          j,
          mode: 'fillet',
          x,
          psi,
          fillet: rounded,
          trimI: project(rounded.ta, a),
          trimJ: project(rounded.tb, b),
        };
      }
    }
    return { i, j, mode: 'bevel', x, psi, fillet: null, trimI: t, trimJ: t };
  }

  // --- Normal case: a curb return. ---------------------------------------- The radius is grown, when it has to be
  let radius = scaled;
  if (mouthTrims.length) {
    const need =
      Math.max(
        (mouthTrims[i] ?? 0) - project(x, a),
        (mouthTrims[j] ?? 0) - project(x, b),
      ) * Math.tan(psi / 2);
    if (need > radius && need <= CORNER_MITER * maxHw) radius = need;
  }
  const fillet = radius > 0 ? filletCorner(x, a.dir, b.dir, radius) : null;

  if (!fillet) {
    const t = Math.max(project(x, a), project(x, b));
    return { i, j, mode: 'bevel', x, psi, fillet: null, trimI: t, trimJ: t };
  }

  // The reported trims are CLAMPED to the mouths the legs already have.
  const cap = (value: number, index: number): number =>
    mouthTrims.length ? Math.min(value, mouthTrims[index] ?? value) : value;

  return {
    i,
    j,
    mode: 'fillet',
    x,
    psi,
    fillet,
    trimI: cap(project(fillet.ta, a), i),
    trimJ: cap(project(fillet.tb, b), j),
  };
}

const collinear = (i: number, j: number, psi: number, t: number): Corner => ({
  i,
  j,
  mode: 'collinear',
  x: null,
  psi,
  fillet: null,
  trimI: t,
  trimJ: t,
});

/** Distance along `leg` at which `p` sits, measured from the leg's ray origin. */
const project = (p: Vec2, leg: Leg): number =>
  dot(sub(p, leg.origin), leg.dir);
