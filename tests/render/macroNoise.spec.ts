import { describe, expect, it } from 'vitest';
import { macroNoiseInto } from '@render/buildings/shellParts';

/** THE SHELL'S TONE NOISE WRITTEN OUT, NOT RETURNED (`shellParts.ts` `macroNoiseInto`): the noise the eight corners hashed one by one gave, bit for bit */

function noiseHash(i: number, j: number, k: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x3c6ef372);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4_294_967_296;
}
/** The noise as it was worked out before. */
function before(x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  let fx = x - x0, fy = y - y0, fz = z - z0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const p0a = noiseHash(x0, y0, z0), p0b = noiseHash(x0 + 1, y0, z0), p0c = noiseHash(x0, y0 + 1, z0), p0d = noiseHash(x0 + 1, y0 + 1, z0);
  const p1a = noiseHash(x0, y0, z0 + 1), p1b = noiseHash(x0 + 1, y0, z0 + 1), p1c = noiseHash(x0, y0 + 1, z0 + 1), p1d = noiseHash(x0 + 1, y0 + 1, z0 + 1);
  const ab0 = p0a + (p0b - p0a) * fx, cd0 = p0c + (p0d - p0c) * fx;
  const ab1 = p1a + (p1b - p1a) * fx, cd1 = p1c + (p1d - p1c) * fx;
  const plane0 = ab0 + (cd0 - ab0) * fy, plane1 = ab1 + (cd1 - ab1) * fy;
  return plane0 + (plane1 - plane0) * fz;
}

describe("the shell's tone noise", () => {
  it('is the one each corner hashed alone gave, bit for bit, across the lattice, negative and on its lines', () => {
    const out = new Float64Array(1);
    let n = 0;
    for (let a = -40; a <= 40; a++) {
      for (const [x, y, z] of [[a * 0.37, a * -0.91, a * 0.13], [a, -a, a * 0.5], [a * 123.456, a * 7.25, -a * 3.5]] as const) {
        macroNoiseInto(x, y, z, out, 0);
        expect(Object.is(out[0], before(x, y, z)), `${x} ${y} ${z}`).toBe(true);
        n++;
      }
    }
    expect(n).toBe(243);
  });
});
