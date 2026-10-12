import { describe, expect, it } from 'vitest';
import { normalTexels } from '../../src/render/mesh/textureBaker';

/** As three reads a normal map (normal_fragment_maps): each channel `* 2.0 - 1.0`. */
const decode = (texels: Uint8ClampedArray, i: number): [number, number, number] =>
  [0, 1, 2].map((c) => ((texels[i * 4 + c] as number) / 255) * 2 - 1) as [number, number, number];

describe('normalTexels', () => {
  it('a flat field decodes to straight out of the surface', () => {
    const size = 4;
    const out = new Uint8ClampedArray(size * size * 4);
    normalTexels(new Float32Array(size * size).fill(0.5), size, 3, out);
    const [x, y, z] = decode(out, 5);
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(Math.abs(y)).toBeLessThan(0.01);
    expect(z).toBeGreaterThan(0.99);
  });

  it('a steep step decodes to a unit normal facing out, as the slope says', () => {
    // A brick-to-mortar step under a strong relief: length well past 2, where
    // z written as 1/length decoded inward.
    const size = 8;
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) height[y * size + x] = x < 4 ? 0.1 : 0.75;
    for (const strength of [1, 3.2, 5.5]) {
      const out = new Uint8ClampedArray(size * size * 4);
      normalTexels(height, size, strength, out);
      const at = 2 * size + 4; // the texel on the step
      const dx = (0.75 - 0.1) * strength;
      const length = Math.sqrt(dx * dx + 1);
      const [nx, ny, nz] = decode(out, at);
      expect(nz).toBeGreaterThan(0);
      expect(nz).toBeCloseTo(1 / length, 1);
      expect(nx).toBeCloseTo(-dx / length, 1);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 1);
    }
  });
});
