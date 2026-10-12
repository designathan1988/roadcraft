import { Vector3 } from 'three';

/**
 * THE FRAMES OF A RAGDOLL'S JOINTS, ALWAYS VALID (docs/PROBLEMS.md R1).
 *
 * Jolt builds a joint's frame as a rotation from the axes it is given:
 * a swing-twist joint from (twist, plane x twist, plane), a hinge from its hinge
 * and normal axes (JoltPhysics `SwingTwistConstraint.cpp`, `HingeConstraint.h`:
 * "mHingeAxis1 and mNormalAxis1 should be perpendicular"). That is a rotation
 * only when the two axes are unit long and perpendicular. The debug build of
 * Jolt reported, under a bomb, thousands of `ioSwing.IsNormalized()` and
 * `inWorldSpaceAxis.IsNormalized()` failures: a thigh's cone leant forwards had
 * its twist axis turned and its plane axis not, and a limb torn off left
 * particles on one point, so a bone's direction was zero. The release build
 * checks nothing; the error grew in the solver until `Step` broke ("table index
 * is out of bounds").
 *
 * Every function here returns unit, perpendicular axes whatever the particles
 * are, falling back to a fixed axis when a direction is degenerate.
 */

const EPS = 1e-10;

/** `v` normalized, or `fallback` (unit) when `v` has no length to speak of. Writes into `v`. */
export function unitOr(v: Vector3, fallback: Vector3): Vector3 {
  return v.lengthSq() > EPS ? v.normalize() : v.copy(fallback);
}

/** A unit vector perpendicular to the unit vector `axis`. */
export function perpendicular(axis: Vector3): Vector3 {
  const other = Math.abs(axis.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return new Vector3().crossVectors(axis, other).normalize();
}

/** The direction from `a` to `b`, unit; `fallback` (unit) when they coincide. */
export function direction(a: Vector3, b: Vector3, fallback: Vector3): Vector3 {
  return unitOr(new Vector3().subVectors(b, a), fallback);
}

/** `v` with its part along the unit `axis` removed, unit; a perpendicular of `axis` when nothing is left. */
export function across(v: Vector3, axis: Vector3, fallback?: Vector3): Vector3 {
  const q = v.clone().addScaledVector(axis, -v.dot(axis));
  if (q.lengthSq() > 1e-6) return q.normalize();
  if (fallback) {
    const f = fallback.clone().addScaledVector(axis, -fallback.dot(axis));
    if (f.lengthSq() > 1e-6) return f.normalize();
  }
  return perpendicular(axis);
}

/**
 * A cone (swing-twist) joint's two frames: `twist2` along the bone (unit),
 * its plane axis across it towards `side`; frame 1 is the same pair turned by
 * `lean` about `side`, so it stays a rotation.
 */
export function coneFrames(twist2: Vector3, side: Vector3, lean: number, fallback: Vector3): { twist1: Vector3; twist2: Vector3; plane1: Vector3; plane2: Vector3 } {
  const plane2 = across(side, twist2, fallback);
  if (!lean) return { twist1: twist2.clone(), twist2, plane1: plane2.clone(), plane2 };
  return { twist1: twist2.clone().applyAxisAngle(side, lean), twist2, plane1: plane2.clone().applyAxisAngle(side, lean), plane2 };
}

/**
 * A hinge from the upper bone `t` and the lower bone `s` (both unit): the
 * axis it bends about the right way (`bends`: where the lower bone goes as it
 * bends), the normal across it along `t`, and how far it is bent now.
 */
export function hingeFrame(t: Vector3, s: Vector3, bends: Vector3): { axis: Vector3; normal: Vector3; bent: number } {
  const fallback = across(new Vector3().crossVectors(t, bends), t);
  let axis = new Vector3().crossVectors(t, s);
  let bent = axis.length() > 0.15 ? Math.atan2(axis.length(), t.dot(s)) : 0;
  if (axis.length() <= 0.15 || axis.dot(fallback) < 0) {
    axis = fallback;
    bent = Math.atan2(new Vector3().crossVectors(t, s).dot(axis), t.dot(s));
  } else axis.normalize();
  // The axis is perpendicular to `t` by construction (a cross product with it,
  // or `across` it), so the normal along `t` is `t` itself made exact.
  const normal = across(t, axis);
  return { axis, normal, bent };
}

/** Whether `a` and `b` are unit and perpendicular, within what Jolt accepts (1e-4 on a normalization). */
export function validFrame(a: Vector3, b: Vector3): boolean {
  const ok = (x: number): boolean => Number.isFinite(x);
  return ok(a.x) && ok(a.y) && ok(a.z) && ok(b.x) && ok(b.y) && ok(b.z)
    && Math.abs(a.length() - 1) < 1e-4 && Math.abs(b.length() - 1) < 1e-4 && Math.abs(a.dot(b)) < 1e-4;
}
