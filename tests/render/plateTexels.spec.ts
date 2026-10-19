import { describe, expect, it } from 'vitest';
import { cellDiagonal } from '@world/groundPatch';
import type { EcologyField } from '@world/ecology';
import { buildPlateMesh } from '@render/plateMesh';
import { ecologyCornersInto, groundCornersInto, landTexelsInto, lightLayerInto, lightRectInto } from '@render/plateTexels';

/** A TERRAIN PLATE'S TEXELS WORKED OUT FROM THEIR TRUTH AT EACH SEND are the ones it used to keep (`render/plateTexels.ts`) */
const side = 321, seg = side - 1, half = 1024, cell = (2 * half) / seg, base = -0.048;
const ground = new Float64Array(side * side);
for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) ground[j * side + i] = 6 * Math.sin(i * 0.37) * Math.cos(j * 0.23) + (i > 200 && j < 120 ? 9 : 0) + i * 0.05;

describe('the land\'s texels from the heights', () => {
  const mesh = buildPlateMesh(ground, side, half, cell, base);

  it('are the workers\' texels of the whole plate', () => {
    const texels = new Float32Array(side * side * 4);
    landTexelsInto(mesh.heights, mesh.flip, side, half, cell, texels, null);
    for (let v = 0; v < side * side; v++) {
      expect(texels[v * 4 + 2]).toBe(mesh.texels[v * 4 + 2]);
      expect(texels[v * 4 + 3]).toBe(mesh.texels[v * 4 + 3]);
    }
    for (let v = 0; v < side * side * 4; v += 13) expect(texels[v]).toBeCloseTo(mesh.texels[v]!, 6);
  });

  it('of a moved box and a corner round it are the whole plate\'s worked out again', () => {
    // Corners raised in a box, the diagonals round them chosen again, as `terrain.ts` cornersMoved does.
    const heights = Float64Array.from(mesh.heights);
    const flip = Uint8Array.from(mesh.flip);
    const x0 = 120, x1 = 150, y0 = 40, y1 = 52;
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) heights[ix + iy * side] = heights[ix + iy * side]! + 4 + 0.3 * ix;
    for (let cy = y0 - 1; cy <= y1; cy++) for (let cx = x0 - 1; cx <= x1; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      flip[cx + cy * seg] = cellDiagonal(heights[a]!, heights[b]!, heights[c]!, heights[d]!);
    }
    // The texels as they were, the box sent again; and the whole plate worked out from nothing.
    const edited = Float32Array.from(mesh.texels);
    landTexelsInto(heights, flip, side, half, cell, edited, { x0: x0 - 1, x1: x1 + 1, y0: y0 - 1, y1: y1 + 1 });
    const whole = new Float32Array(side * side * 4);
    landTexelsInto(heights, flip, side, half, cell, whole, null);
    for (let v = 0; v < side * side * 4; v++) expect(edited[v]).toBeCloseTo(whole[v]!, 6);
  });
});

describe('the shore array from the corner store', () => {
  const n = 9;
  const levels = new Float32Array(n).fill(-100_000);
  levels[3] = 4.25;
  const sand = Float32Array.from({ length: n }, (_, k) => k / 8);
  const basalt = Float32Array.from({ length: n }, (_, k) => 1 - k / 8);
  const density = (k: number, kind: string): number => ((k * 37 + kind.length * 11) % 256) / 255;

  it('packs the covers and the geology as the plates did, two bytes a channel, the forest\'s byte (the level a texture of its own, TER-07)', () => {
    const into = new Uint16Array(n * 4);
    groundCornersInto(into, { levels, sand, basalt }, density);
    const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let k = 0; k < n; k++) {
      // The former pack, from a Float32 copy of each cover.
      const flowers = Math.fround(density(k, 'flowers')), scrub = Math.fround(density(k, 'scrub')), forest = Math.fround(density(k, 'forest'));
      expect(into[k * 4]).toBe(byte(flowers) + 256 * byte(sand[k]!));
      expect(into[k * 4 + 1]).toBe(byte(scrub) + 256 * byte(basalt[k]!));
      // The forest is a byte of the covers' grid (`coverOf`): its byte over 255 is the float the plates sent.
      expect(Math.fround(into[k * 4 + 2]! / 255)).toBe(forest);
      expect(into[k * 4 + 3]).toBe(0);
    }
  });

  it('carries the ecology\'s classes as bytes, none without an ecosystem', () => {
    const value = (k: number): number => (k % 5) / 4;
    const field = {
      canopy: Float32Array.from({ length: n }, (_, k) => value(k) * 0.5), trees: Float32Array.from({ length: n }, (_, k) => value(k + 1) * 0.4),
      palm: Float32Array.from({ length: n }, (_, k) => value(k + 2)), grass: Float32Array.from({ length: n }, (_, k) => value(k + 3)),
      dry: Float32Array.from({ length: n }, (_, k) => value(k + 4)), wet: Float32Array.from({ length: n }, (_, k) => value(k)),
    } as unknown as EcologyField;
    const into = new Float32Array(n * 8).fill(9);
    ecologyCornersInto(into, n * 4, n, field);
    const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let i = 0; i < n; i++) {
      const canopy = field.canopy[i]!, trees = field.trees[i]!, grass = field.grass[i]!;
      expect(into[n * 4 + i * 4]).toBe(Math.fround(byte(canopy + trees * 0.3 + field.palm[i]! * 0.25) / 255));
      expect(into[n * 4 + i * 4 + 1]).toBe(Math.fround(byte(grass * field.dry[i]!) / 255));
      expect(into[n * 4 + i * 4 + 2]).toBe(Math.fround(byte(field.wet[i]!) / 255));
      expect(into[n * 4 + i * 4 + 3]).toBe(Math.fround(byte((1 - grass) * (1 - Math.min(1, canopy + trees))) / 255));
    }
    // The first layer untouched; none of an ecosystem is zero.
    expect(into[0]).toBe(9);
    ecologyCornersInto(into, n * 4, n, null);
    expect(into.subarray(n * 4).every((v) => v === 0)).toBe(true);
  });
});

describe('the light layer from the light store', () => {
  it('lays the corners\' light at the layer\'s stride, nothing past them, and a worker\'s rect into both', () => {
    const corners = 3, res = 4;
    const light = Uint8Array.from({ length: corners * corners * 4 }, (_, i) => i + 1);
    const layer = new Uint8Array(res * res * 4).fill(200);
    lightLayerInto(layer, res, light, corners);
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) for (let c = 0; c < 4; c++) {
      expect(layer[(y * res + x) * 4 + c]).toBe(x < corners && y < corners ? light[(y * corners + x) * 4 + c] : 0);
    }
    const rgba = new Uint8Array(2 * 1 * 4).fill(77);
    lightRectInto(light, corners, { x0: 1, x1: 2, y0: 2, y1: 2 }, rgba, layer, res);
    expect(light[(2 * corners + 1) * 4]).toBe(77);
    expect(light[(2 * corners + 2) * 4 + 3]).toBe(77);
    expect(layer[(2 * res + 1) * 4]).toBe(77);
    expect(layer[(2 * res + 0) * 4]).toBe(light[(2 * corners) * 4]);
  });
});
