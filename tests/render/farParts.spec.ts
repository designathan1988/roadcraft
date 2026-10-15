import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { createBuildingKit } from '@render/buildings/kit';

/** A RAILING IS SEEN FROM BOTH SIDES. */
function faces(g: BufferGeometry): { at: string; n: [number, number, number] }[] {
  const p = g.getAttribute('position'), idx = g.getIndex();
  const count = idx ? idx.count : p.count;
  const out: { at: string; n: [number, number, number] }[] = [];
  for (let t = 0; t + 2 < count; t += 3) {
    const v = [0, 1, 2].map((k) => { const i = idx ? idx.getX(t + k) : t + k; return [p.getX(i), p.getY(i), p.getZ(i)]; });
    const [a, b, c] = v as [number[], number[], number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n: [number, number, number] = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const l = Math.hypot(...n) || 1;
    const centre = [0, 1, 2].map((k) => ((a[k]! + b[k]! + c[k]!) / 3).toFixed(4)).join(',');
    out.push({ at: centre, n: [n[0] / l, n[1] / l, n[2] / l] });
  }
  return out;
}

describe('the far parts', () => {
  it('draw every railing face from both sides', () => {
    const kit = createBuildingKit();
    for (const kind of ['railing', 'roofRailing'] as const) {
      const g = kit.far[kind];
      expect(g, kind).toBeDefined();
      const all = faces(g!);
      const lonely = all.filter((f) => !all.some((o) => o.at === f.at && o.n[0] * f.n[0] + o.n[1] * f.n[1] + o.n[2] * f.n[2] < -0.99));
      expect(lonely.length, kind).toBe(0);
    }
  });
});
