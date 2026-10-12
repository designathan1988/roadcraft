import { describe, expect, it } from 'vitest';
import { steepnessInto, triangleSteep } from '@render/terrainSteep';

/**
 * A PLATE'S STEEPNESS, READ ONCE A CELL (`render/terrainSteep.ts`): the same
 * answer, corner by corner, as the old reading of every corner's eight faces
 * - only without working each face out six times.
 */
function reference(p: Float32Array, flip: Uint8Array, side: number): Float32Array {
  const seg = side - 1;
  const out = new Float32Array(side * side);
  for (let v = 0; v < side * side; v++) {
    const ix = v % side, iy = (v - ix) / side;
    let most = 0;
    for (let cy = iy - 1; cy <= iy; cy++) {
      for (let cx = ix - 1; cx <= ix; cx++) {
        if (cx < 0 || cy < 0 || cx >= seg || cy >= seg) continue;
        const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
        const faces = flip[cx + cy * seg] ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
        for (const [i, j, k] of faces) most = Math.max(most, triangleSteep(p, i!, j!, k!));
      }
    }
    out[v] = most;
  }
  return out;
}

describe("a plate's steepness", () => {
  it('matches every corner of the eight-face reading on rough ground', () => {
    const side = 41;
    let seed = 7;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const p = new Float32Array(side * side * 3);
    for (let v = 0; v < side * side; v++) {
      const ix = v % side, iy = (v - ix) / side;
      p[v * 3] = ix * 4;
      p[v * 3 + 1] = Math.sin(ix * 0.7) * 6 + random() * 9 - (iy > 20 ? iy * 3 : 0);
      p[v * 3 + 2] = iy * 4;
    }
    const flip = new Uint8Array((side - 1) * (side - 1)).map(() => (random() > 0.5 ? 1 : 0));
    const out = new Float32Array(side * side);
    steepnessInto(p, flip, side, new Float32Array((side - 1) * (side - 1)), out);
    const want = reference(p, flip, side);
    let most = 0;
    for (let v = 0; v < out.length; v++) {
      expect(out[v]).toBeCloseTo(want[v]!, 5);
      most = Math.max(most, out[v]!);
    }
    // Rough enough to mean something: walls past 50 degrees in it.
    expect(most).toBeGreaterThan(50);
  });
});
