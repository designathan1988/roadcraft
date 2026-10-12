import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS } from '@core/cubeSphere';

/**
 * THE ANGLE FROM THE POINT LOOKED AT, IN THE SHADER'S PRECISION
 * (`render/planet/bend.ts` `planetFromAnchor`).
 *
 * The planet is drawn by carrying every vertex along the ground from the
 * anchor (the point looked at) by its angle there. The shader works in
 * float32: the angle read as acos of the two unit vectors' dot product came
 * out 0 for every vertex within about 1.5 m of the anchor, and wires and
 * fittings in the middle of the screen were drawn as shards on the anchor's
 * up line (seen 2026-10-11, a pole line at the centre of the view). The
 * angle from the vectors' difference, 2 atan2(|s - a|, |s + a|), keeps it.
 * Each operation is rounded to float32 here as the GPU rounds it.
 */

const f = Math.fround;
type V = [number, number, number];
const sub = (a: V, b: V): V => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const add = (a: V, b: V): V => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const dot = (a: V, b: V): number => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const len = (a: V): number => f(Math.sqrt(dot(a, a)));

/** A unit vector at `arc` (world units along the sphere) from `a`, rounded to float32 as a vertex's direction is. */
function around(a: V, east: V, arc: number): V {
  const th = arc / PLANET_RADIUS;
  return [f(a[0] * Math.cos(th) + east[0] * Math.sin(th)), f(a[1] * Math.cos(th) + east[1] * Math.sin(th)), f(a[2] * Math.cos(th) + east[2] * Math.sin(th))];
}

const oldAngle = (s: V, a: V): number => f(Math.acos(Math.min(1, Math.max(-1, dot(s, a)))));
const newAngle = (s: V, a: V): number => f(2 * Math.atan2(len(sub(s, a)), len(add(s, a))));

describe('the angle from the anchor in float32', () => {
  // An anchor off every axis, as a place on the planet is.
  const raw: V = [0.31, 0.72, -0.62];
  const l = Math.hypot(...raw);
  const a: V = [f(raw[0] / l), f(raw[1] / l), f(raw[2] / l)];
  const ex = [0.92, -0.39, 0];
  const ed = ex[0]! * a[0] + ex[1]! * a[1];
  const e0: V = [ex[0]! - ed * a[0], ex[1]! - ed * a[1], -ed * a[2]];
  const el = Math.hypot(...e0);
  const east: V = [e0[0] / el, e0[1] / el, e0[2] / el];

  it('keeps a vertex near the point looked at where it is, to a millimetre', () => {
    let worstNew = 0, worstOld = 0;
    for (const arc of [0.05, 0.2, 0.5, 1, 2, 4, 10, 40, 200, 1000]) {
      const s = around(a, east, arc);
      worstNew = Math.max(worstNew, Math.abs(newAngle(s, a) * PLANET_RADIUS - arc));
      worstOld = Math.max(worstOld, Math.abs(oldAngle(s, a) * PLANET_RADIUS - arc));
    }
    // World units; 1 mm is 0.0025 of a unit at 0.4 m a unit.
    expect(worstNew).toBeLessThan(0.0025);
    // What the acos lost: metres.
    expect(worstOld).toBeGreaterThan(1);
  });
});
