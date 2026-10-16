import { describe, expect, it } from 'vitest';
import { createGroundCorners } from '@render/ragdollGround';

/** THE BODIES' GROUND IS KEPT WHILE SOMETHING MOVES ON IT, NEVER CLEARED BY A CAP (`render/ragdollGround.ts`). */

/** A rolling ground with a step in it (a kerb), and a hole the ground gives as NaN. */
const ground = (x: number, y: number): number =>
  x > 40 && x < 41 && y > 40 && y < 41 ? NaN : Math.sin(x * 0.37) * 2 + Math.cos(y * 0.21) + (x > 3 ? 0.15 : 0);

/** The sampler as it was (`playEffects.ts` before): corners in a map by a mixed key, read between. */
function before(corner: (x: number, y: number) => number): (x: number, y: number) => number {
  const known = new Map<number, number>();
  const at = (ix: number, iy: number): number => {
    const key = ix * 100003 + iy;
    const h = known.get(key);
    if (h !== undefined) return h;
    const v = corner(ix / 5, iy / 5);
    known.set(key, v);
    return v;
  };
  return (x, y) => {
    const gx = x * 5, gy = y * 5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** A small seeded generator, so a failure shows the same points again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the ground under the bodies', () => {
  it('gives the heights the old sampler gave, on both sides of zero and across tiles', () => {
    const old = before(ground);
    const now = createGroundCorners(ground);
    const r = random(7);
    for (let i = 0; i < 5000; i++) {
      const x = (r() - 0.5) * 200, y = (r() - 0.5) * 200;
      expect(Object.is(now.at(x, y), old(x, y)) || now.at(x, y) === old(x, y), `${x}, ${y}`).toBe(true);
      if (i % 500 === 0) now.sweep();
    }
    // Inside the hole: NaN, as before.
    expect(now.at(40.5, 40.5)).toBeNaN();
  });

  it('asks the ground for a corner once while something keeps reading it, and lets go of what nobody reads', () => {
    let asked = 0;
    const now = createGroundCorners((x, y) => { asked++; return ground(x, y); });
    const body = (frame: number): number => now.at(10 + frame * 0.01, -3);
    body(0);
    const first = asked;
    expect(now.tiles).toBe(1);
    // A body moving a centimetre a frame for a hundred frames: the corners it crosses, each once.
    for (let frame = 1; frame < 100; frame++) { now.sweep(); body(frame); }
    expect(asked).toBeLessThanOrEqual(first + 2 * 6);
    // Something thrown far once, then nothing there: its tile goes at the second sweep after it, the body's stays.
    now.at(-500, 900);
    expect(now.tiles).toBe(2);
    now.sweep(); body(100);
    now.sweep(); body(101);
    expect(now.tiles).toBe(1);
    // Everything lying still reads nothing: nothing is kept.
    now.sweep(); now.sweep();
    expect(now.tiles).toBe(0);
  });

  it('forgets every height when the ground changes', () => {
    let lift = 0;
    const now = createGroundCorners((x, y) => ground(x, y) + lift);
    const was = now.at(5.05, 5.05);
    lift = 1;
    expect(now.at(5.05, 5.05)).toBe(was);
    now.forget();
    expect(now.at(5.05, 5.05)).toBeCloseTo(was + 1, 12);
  });
});
