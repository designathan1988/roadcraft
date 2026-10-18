import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Float32BufferAttribute, TorusGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { weldGeometry } from '@render/mesh/weld';

/** The numeric weld against three's own `mergeVertices`: the same geometry out, attribute by attribute. */

function same(a: BufferGeometry, b: BufferGeometry): void {
  expect(Object.keys(a.attributes).sort()).toEqual(Object.keys(b.attributes).sort());
  for (const name of Object.keys(a.attributes)) {
    const x = a.getAttribute(name) as BufferAttribute, y = b.getAttribute(name) as BufferAttribute;
    expect(x.constructor).toBe(y.constructor);
    expect(x.itemSize).toBe(y.itemSize);
    expect(x.normalized).toBe(y.normalized);
    expect(Array.from(x.array)).toEqual(Array.from(y.array));
  }
  expect(a.index!.constructor).toBe(b.index!.constructor);
  expect(Array.from(a.index!.array)).toEqual(Array.from(b.index!.array));
  expect(a.groups).toEqual(b.groups);
}

/** A loose triangle list with corners repeated, some a hair apart, and a colour. */
function loose(seed: number, triangles: number): BufferGeometry {
  let s = seed;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const corners: number[][] = [];
  for (let i = 0; i < 40; i++) corners.push([rnd() * 50 - 25, rnd() * 50, rnd() * 50 - 25, rnd(), rnd(), rnd()]);
  const pos: number[] = [], col: number[] = [];
  for (let t = 0; t < triangles * 3; t++) {
    const c = corners[Math.floor(rnd() * corners.length)]!;
    const jitter = rnd() < 0.2 ? (rnd() - 0.5) * 2e-5 : 0;
    pos.push(c[0]! + jitter, c[1]!, c[2]!);
    col.push(c[3]!, c[4]!, c[5]!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

describe('weldGeometry', () => {
  it('makes what three makes of loose triangle lists', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const g = loose(seed, 600);
      same(weldGeometry(g), mergeVertices(g));
      same(weldGeometry(g, 1e-2), mergeVertices(g, 1e-2));
    }
  });

  it('makes what three makes of indexed and split primitives', () => {
    for (const g of [new BoxGeometry(2, 3, 4, 2, 2, 2), new CylinderGeometry(1, 1.5, 3, 24, 3), new TorusGeometry(3, 1, 12, 32)]) {
      same(weldGeometry(g), mergeVertices(g));
      const split = g.toNonIndexed();
      same(weldGeometry(split), mergeVertices(split));
    }
  });

  it('chooses the wide index past 65,534 vertices, as three does', () => {
    const g = loose(9, 1);
    const n = 70_000, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos[i * 3] = i;
    const big = new BufferGeometry();
    big.setAttribute('position', new BufferAttribute(pos, 3));
    same(weldGeometry(big), mergeVertices(big));
    same(weldGeometry(g), mergeVertices(g));
  });

  it('keeps normalized attributes as three does', () => {
    const g = loose(3, 200);
    const n = g.getAttribute('position').count, bytes = new Uint8Array(n * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 3 === 0 ? 255 : 128;
    g.setAttribute('tint', new BufferAttribute(bytes, 4, true));
    same(weldGeometry(g), mergeVertices(g));
  });
});
