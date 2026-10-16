import { describe, expect, it } from 'vitest';
import { emitChunk, withShellParts } from '@render/buildings/buildingMesh';
import { m } from '@world/units';
import { growCity } from '../world/cityAudit';

/** A PARAPET IS A WALL WITH TWO FACES. */
describe('the parapets', () => {
  it('have an inner face behind every outer one', () => {
    const city = growCity({ size: 'small', seed: 1 });
    const lonely: string[] = [];
    let checked = 0;
    // Blocks under flat roofs with a parapet all round (no pitched roof, whose gables are one wall by nature).
    const parapeted = (x: (typeof city.doc.buildings extends { all(): Iterable<infer B> } ? B : never)): boolean => {
      const closed = x.volumes.filter((v) => !v.open);
      return closed.length > 0 && closed.every((v) => v.roof === 'flat' && v.dress?.crown !== 'none' && v.storeys.length >= 3);
    };
    for (const b of [...city.doc.buildings.all()].filter((x, i) => i % 3 === 0 && parapeted(x))) {
      const chunk = withShellParts(emitChunk(b, () => 0));
      // Every vertical face of the shells, by its centre and normal (three's frame: y up).
      const faces: { c: [number, number, number]; n: [number, number] }[] = [];
      for (const shell of Object.values(chunk.shells)) {
        if (!shell) continue;
        const { position: p, index: idx } = shell;
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const a = idx[t]! * 3, bb = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
          const ux = p[bb]! - p[a]!, uy = p[bb + 1]! - p[a + 1]!, uz = p[bb + 2]! - p[a + 2]!;
          const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz);
          if (l < 1e-9 || Math.abs(ny / l) > 0.1) continue;
          faces.push({ c: [(p[a]! + p[bb]! + p[c]!) / 3, (p[a + 1]! + p[bb + 1]! + p[c + 1]!) / 3, (p[a + 2]! + p[bb + 2]! + p[c + 2]!) / 3], n: [nx / l, nz / l] });
        }
      }
      // The parapets: the vertical faces in the band just over each flat roof's slab.
      const top = Math.max(...faces.map((f) => f.c[1]));
      for (const f of faces) {
        if (f.c[1] < top - m(0.8)) continue;
        checked++;
        const twin = faces.some((g) => g !== f && g.n[0] * f.n[0] + g.n[1] * f.n[1] < -0.95 && Math.abs(g.c[1] - f.c[1]) < m(0.5)
          && Math.hypot(g.c[0] - f.c[0], g.c[2] - f.c[2]) < m(6));
        if (!twin) lonely.push(`${b.id} (${f.c.map((x) => x.toFixed(1)).join(', ')})`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(lonely.slice(0, 10)).toEqual([]);
  });
});
