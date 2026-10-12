import { describe, expect, it } from 'vitest';
import { BufferAttribute, PlaneGeometry } from 'three';
import { buildPlateMesh } from '@render/plateMesh';
import { steepnessInto } from '@render/terrainSteep';

/**
 * A PLATE'S MESH BUILT OFF THE PAGE (`render/plateMesh.ts`) IS THE ONE THE
 * PAGE BUILDS (`terrain.ts` update): the same corners, diagonals, normals
 * (three's `computeVertexNormals` over the same triangles) and steepness - so
 * a plate whose first build comes from the workers looks exactly as one
 * built on the page.
 */
describe('a plate mesh built in the workers', () => {
  it('matches the page\'s own build, corner by corner', () => {
    const side = 41, seg = side - 1, half = 128, cell = (2 * half) / seg, base = -0.048;
    const ground = new Float64Array(side * side);
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) ground[j * side + i] = 6 * Math.sin(i * 0.37) * Math.cos(j * 0.23) + (i > 20 && j < 12 ? 9 : 0) + i * 0.05;
    const mesh = buildPlateMesh(ground, side, half, cell, base);

    // The page's way (`terrain.ts`): the plane laid flat, its corners raised, the diagonals chosen, three's normals.
    const geometry = new PlaneGeometry(2 * half, 2 * half, seg, seg);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    const natural = new Float64Array(side * side);
    for (let v = 0; v < side * side; v++) {
      const h = base + ground[v]!;
      natural[v] = h;
      position.setY(v, h);
      expect(position.getX(v)).toBeCloseTo(-half + (v % side) * cell, 4);
      expect(-position.getZ(v)).toBeCloseTo(half - Math.floor(v / side) * cell, 4);
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
    const steep = new Float32Array(side * side);
    steepnessInto(position.array as Float32Array, flip, side, new Float32Array(seg * seg), steep);

    expect(Array.from(mesh.flip)).toEqual(Array.from(flip));
    expect(flip.some((f) => f === 1)).toBe(true);
    const normal = geometry.getAttribute('normal');
    for (let v = 0; v < side * side; v++) {
      expect(mesh.heights[v]).toBe(natural[v]);
      expect(mesh.normals[v * 3]).toBeCloseTo(normal.getX(v), 5);
      expect(mesh.normals[v * 3 + 1]).toBeCloseTo(normal.getY(v), 5);
      expect(mesh.normals[v * 3 + 2]).toBeCloseTo(normal.getZ(v), 5);
      expect(mesh.steep[v]).toBeCloseTo(steep[v]!, 4);
    }
    expect(mesh.low).toBe(Math.min(...natural));
    expect(mesh.high).toBe(Math.max(...natural));
  });
});
