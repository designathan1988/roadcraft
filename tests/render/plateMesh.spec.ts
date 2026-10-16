import { describe, expect, it } from 'vitest';
import { BufferAttribute, PlaneGeometry } from 'three';
import { buildPlateMesh, landNormalsInto } from '@render/plateMesh';

/** A PLATE'S GROUND BUILT OFF THE PAGE (`render/plateMesh.ts`) IS THE ONE THE PAGE DRAWS (`terrain.ts`, three's normals) */
const side = 321, seg = side - 1, half = 1024, cell = (2 * half) / seg, base = -0.048;
const ground = new Float64Array(side * side);
for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) ground[j * side + i] = 6 * Math.sin(i * 0.37) * Math.cos(j * 0.23) + (i > 200 && j < 120 ? 9 : 0) + i * 0.05;

describe('a plate built in the workers', () => {
  const mesh = buildPlateMesh(ground, side, half, cell, base);

  it('carries the corners, diagonals and normals of three\'s own mesh of it', () => {
    // The page's former way: the plane laid flat, its corners raised, the diagonals chosen, three's normals.
    const geometry = new PlaneGeometry(2 * half, 2 * half, seg, seg);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    const natural = new Float64Array(side * side);
    for (let v = 0; v < side * side; v++) {
      natural[v] = base + ground[v]!;
      position.setY(v, natural[v]!);
    }
    const flip = new Uint8Array(seg * seg);
    const index = new Uint32Array(seg * seg * 6);
    for (let cy = 0; cy < seg; cy++) for (let cx = 0; cx < seg; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      const k = cx + cy * seg, o = k * 6;
      flip[k] = Math.abs(natural[a]! - natural[c]!) + 0.5 < Math.abs(natural[b]! - natural[d]!) ? 1 : 0;
      if (flip[k]) index.set([a, b, c, a, c, d], o); else index.set([a, b, d, b, c, d], o);
    }
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeVertexNormals();

    expect(Array.from(mesh.flip)).toEqual(Array.from(flip));
    expect(flip.some((f) => f === 1)).toBe(true);
    const normal = geometry.getAttribute('normal');
    for (let v = 0; v < side * side; v += 7) {
      expect(mesh.heights[v]).toBe(natural[v]);
      expect(mesh.texels[v * 4 + 3]).toBe(Math.fround(natural[v]!));
      expect(mesh.texels[v * 4]).toBeCloseTo(normal.getX(v), 5);
      expect(mesh.texels[v * 4 + 1]).toBeCloseTo(normal.getZ(v), 5);
      const ix = v % side, iy = Math.floor(v / side);
      expect(mesh.texels[v * 4 + 2]).toBe(ix < seg && iy < seg ? flip[ix + iy * seg] : 0);
    }
  });

  it('works a box of normals out again as the whole plate does', () => {
    const texels = new Float32Array(mesh.texels.length);
    landNormalsInto(mesh.heights, mesh.flip, side, half, cell, texels, 100, 140, 30, 61);
    for (let iy = 30; iy <= 61; iy++) {
      for (let ix = 100; ix <= 140; ix++) {
        const v = ix + iy * side;
        expect(texels[v * 4]).toBeCloseTo(mesh.texels[v * 4]!, 6);
        expect(texels[v * 4 + 1]).toBeCloseTo(mesh.texels[v * 4 + 1]!, 6);
      }
    }
  });
});
