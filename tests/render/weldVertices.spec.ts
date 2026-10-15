import { describe, expect, it } from 'vitest';

import { weldVertices } from '@render/mesh/tileMesh';

/** WELDING THE VERTICES THAT ARE THE SAME (`tileMesh.ts` `weldVertices`) */
describe('welding the vertices of a mesh', () => {
  let seed = 5;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

  function soup(copies: boolean): { positions: number[]; normals: number[]; uvs: number[]; colors: number[]; sections: number[]; indices: number[] } {
    const out = { positions: [] as number[], normals: [] as number[], uvs: [] as number[], colors: [] as number[], sections: [] as number[], indices: [] as number[] };
    const distinct = 60;
    const base = Array.from({ length: distinct }, () => ({
      p: [rand() * 100, rand() * 5, rand() * 100], n: [rand() - 0.5, rand(), rand() - 0.5], u: [rand() * 50, rand() * 50], c: [0.9 + rand() * 0.2, 1, 1], s: [Math.floor(rand() * 5) - 2, rand(), 0],
    }));
    for (let t = 0; t < 400; t++) for (let k = 0; k < 3; k++) {
      const v = base[Math.floor(rand() * distinct)]!;
      // Some corners differ from the vertex they look like in one thing only.
      const tweak = copies && rand() < 0.15;
      out.positions.push(...v.p);
      out.normals.push(...(tweak ? [v.n[0]! + 1e-7, v.n[1]!, v.n[2]!] : v.n));
      out.uvs.push(...v.u); out.colors.push(...v.c); out.sections.push(...v.s);
      out.indices.push(out.indices.length);
    }
    return out;
  }

  it('gives every triangle corner the attributes it had, from fewer vertices', () => {
    const before = soup(true);
    const welded = weldVertices(before);
    const f32 = (a: number[]): Float32Array => new Float32Array(a);
    const p = f32(before.positions), n = f32(before.normals), u = f32(before.uvs), c = f32(before.colors), q = f32(before.sections);
    expect(welded.indices.length).toBe(before.indices.length);
    for (let i = 0; i < before.indices.length; i++) {
      const w = welded.indices[i]!, o = before.indices[i]!;
      for (let k = 0; k < 3; k++) {
        expect(welded.positions[w * 3 + k]).toBe(p[o * 3 + k]);
        expect(welded.normals[w * 3 + k]).toBe(n[o * 3 + k]);
        expect(welded.colors[w * 3 + k]).toBe(c[o * 3 + k]);
        expect(welded.sections[w * 3 + k]).toBe(q[o * 3 + k]);
      }
      for (let k = 0; k < 2; k++) expect(welded.uvs[w * 2 + k]).toBe(u[o * 2 + k]);
    }
    expect(welded.positions.length / 3).toBeLessThan(before.positions.length / 3 / 4);
  });

  it('keeps apart vertices that differ in the least', () => {
    const base = { positions: [1, 2, 3], normals: [0, 1, 0], uvs: [4, 5], colors: [1, 1, 1], sections: [0, 0, 0] };
    const twin = (over: Partial<typeof base>): ReturnType<typeof weldVertices> => {
      const a = { ...base, ...over };
      return weldVertices({
        positions: [...base.positions, ...a.positions], normals: [...base.normals, ...a.normals], uvs: [...base.uvs, ...a.uvs],
        colors: [...base.colors, ...a.colors], sections: [...base.sections, ...a.sections], indices: [0, 1, 1],
      });
    };
    expect(twin({}).positions.length / 3).toBe(1);
    expect(twin({ normals: [0, 1, 1e-6] }).positions.length / 3).toBe(2);
    expect(twin({ uvs: [4, 5.000001] }).positions.length / 3).toBe(2);
    expect(twin({ colors: [1, 1, 0.99] }).positions.length / 3).toBe(2);
    expect(twin({ sections: [0, 0, 1] }).positions.length / 3).toBe(2);
    expect(twin({ positions: [1, 2, 3.00001] }).positions.length / 3).toBe(2);
  });
});
