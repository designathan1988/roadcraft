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

/** A corner as plain data (`cornerData`, `cornerOf`): what a message's clone keeps of it (`NetworkBake`). */
export type CornerData = { -readonly [K in keyof Corner]: Corner[K] };

/** Where a corner's numbers stand in its run (`PackedCorner`): its wedge and trims, its point (NaN: none), its fillet (NaN: none). */
const PSI = 0, TRIM_I = 1, TRIM_J = 2, XX = 3, XY = 4, TAX = 5, TAY = 6, TBX = 7, TBY = 8, CX = 9, CY = 10, R = 11, RUN = 12;

/** DO NOT keep a corner as an object of points (its point, its fillet's three: ~300 B a corner, 2026-10-21): its numbers in one run, its points made when read (`PackedLeg`). */
class PackedCorner implements Corner {
  constructor(readonly i: number, readonly j: number, readonly mode: CornerMode, private readonly hasX: boolean, private readonly v: readonly number[]) {}

  get psi(): number { return this.v[PSI]!; }
  get trimI(): number { return this.v[TRIM_I]!; }
  get trimJ(): number { return this.v[TRIM_J]!; }
  get x(): Vec2 | null { return this.hasX ? { x: this.v[XX]!, y: this.v[XY]! } : null; }
  get fillet(): Fillet | null {
    const v = this.v;
    return v.length > R ? { ta: { x: v[TAX]!, y: v[TAY]! }, tb: { x: v[TBX]!, y: v[TBY]! }, c: { x: v[CX]!, y: v[CY]! }, r: v[R]!, run: v[RUN]! } : null;
  }
}

/** A corner kept compact (`PackedCorner`) from its fields. */
export function cornerOf(c: Corner): Corner {
  const f = c.fillet;
  const v = new Array<number>(f ? RUN + 1 : XY + 1);
  v[PSI] = c.psi; v[TRIM_I] = c.trimI; v[TRIM_J] = c.trimJ;
  v[XX] = c.x ? c.x.x : NaN; v[XY] = c.x ? c.x.y : NaN;
  if (f) { v[TAX] = f.ta.x; v[TAY] = f.ta.y; v[TBX] = f.tb.x; v[TBY] = f.tb.y; v[CX] = f.c.x; v[CY] = f.c.y; v[R] = f.r; v[RUN] = f.run; }
  return new PackedCorner(c.i, c.j, c.mode, c.x !== null, v);
}

/** The corners' modes by number, for `packCorners`. */
const MODES: readonly CornerMode[] = ['fillet', 'bevel', 'collinear', 'taper'];

/** Corners as one run of numbers (`packLegs`): each its legs, mode, whether it has a point, its run's length, then its run (`PackedCorner`). */
export function packCorners(corners: readonly Corner[]): number[] {
  const out: number[] = [];
  for (const c of corners) {
    const f = c.fillet;
    out.push(c.i, c.j, MODES.indexOf(c.mode), c.x ? 1 : 0, f ? RUN + 1 : XY + 1, c.psi, c.trimI, c.trimJ, c.x ? c.x.x : NaN, c.x ? c.x.y : NaN);
    if (f) out.push(f.ta.x, f.ta.y, f.tb.x, f.tb.y, f.c.x, f.c.y, f.r, f.run);
  }
  return out;
}

/** The corners of `packCorners`. */
export function unpackCorners(nums: readonly number[]): Corner[] {
  const out: Corner[] = [];
  for (let k = 0; k < nums.length;) {
    const n = nums[k + 4]!;
    out.push(new PackedCorner(nums[k]!, nums[k + 1]!, MODES[nums[k + 2]!]!, nums[k + 3] === 1, nums.slice(k + 5, k + 5 + n)));
    k += 5 + n;
  }
  return out;
}

/** A corner's fields as plain data (`CornerData`). */
export function cornerData(c: Corner): CornerData {
  return { i: c.i, j: c.j, mode: c.mode, x: c.x, psi: c.psi, fillet: c.fillet, trimI: c.trimI, trimJ: c.trimJ };
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
    corners.push(cornerOf(resolveCorner(legs, i, j, radiusScale, mouthTrims)));
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
