import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { coneFrames, direction, hingeFrame, validFrame } from '@render/ragdollAxes';
import { Rng } from '@core/rng';

/** A joint's frames are rotations whatever the body's particles are */
describe('the frames of a ragdoll joint', () => {
  const side = new Vector3(1, 0, 0);
  const fwd = new Vector3(0, 0, 1);
  const up = new Vector3(0, 1, 0);

  it('was not a rotation the way the SOURCE built a leant cone', () => {
    // `ragdoll.ts` joltSpec at the SOURCE: the plane from the bone, the twist turned by the lean.
    const t2 = direction(new Vector3(0, 1, 0), new Vector3(0.1, 0.2, 0.3), up);
    const plane = side.clone().addScaledVector(t2, -side.dot(t2)).normalize();
    const t1 = t2.clone().applyAxisAngle(side, 0.5);
    expect(validFrame(t1, plane)).toBe(false);
  });

  it('keeps a leant cone a rotation in both frames', () => {
    const t2 = direction(new Vector3(0, 1, 0), new Vector3(0.1, 0.2, 0.3), up);
    const f = coneFrames(t2, side, 0.5, fwd);
    expect(validFrame(f.twist1, f.plane1)).toBe(true);
    expect(validFrame(f.twist2, f.plane2)).toBe(true);
  });

  it('gives valid axes for a bone of zero length and for a bone along the side', () => {
    const p = new Vector3(2, 3, 4);
    const zero = direction(p, p.clone(), up);
    expect(zero.length()).toBeCloseTo(1, 6);
    const along = coneFrames(side.clone(), side, 0.5, fwd);
    expect(validFrame(along.twist1, along.plane1)).toBe(true);
    expect(validFrame(along.twist2, along.plane2)).toBe(true);
    const h = hingeFrame(zero, zero, fwd);
    expect(validFrame(h.axis, h.normal)).toBe(true);
    const parallel = hingeFrame(fwd.clone(), fwd.clone(), fwd);
    expect(validFrame(parallel.axis, parallel.normal)).toBe(true);
  });

  it('holds over random bodies, the degenerate ones included', () => {
    const rng = new Rng(0x7a11);
    const v = (): Vector3 => {
      const k = rng.float();
      // One case in five: a point shared by two particles (a limb torn off, pinned to its stump).
      return k < 0.2 ? new Vector3(1, 1, 1) : new Vector3(rng.float() * 2 - 1, rng.float() * 2 - 1, rng.float() * 2 - 1);
    };
    for (let i = 0; i < 5000; i++) {
      const a = v(), b = v(), c = v();
      const t = direction(a, b, up), s = direction(b, c, up);
      const h = hingeFrame(t, s, rng.float() < 0.5 ? fwd : fwd.clone().negate());
      expect(validFrame(h.axis, h.normal), `hinge ${i}`).toBe(true);
      const cf = coneFrames(t, direction(v(), v(), side), rng.float() < 0.5 ? 0.5 : 0, fwd);
      expect(validFrame(cf.twist1, cf.plane1), `cone 1 ${i}`).toBe(true);
      expect(validFrame(cf.twist2, cf.plane2), `cone 2 ${i}`).toBe(true);
    }
  });
});
