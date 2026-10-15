import { describe, expect, it } from 'vitest';

import { m } from '@world/units';
import { elementsMeet } from '@world/buildings/elements';
import { growCity } from './cityAudit';

/** NO PART OF A LOT STANDS IN ANOTHER (Etapa 5a). */
describe('the parts of a generated city\'s lots', () => {
  it('never stand in each other', () => {
    // A small city: the same yards, a third of the parts (a medium one took 18 s).
    const city = growCity({ size: 'small' });
    let parts = 0;
    const meets: string[] = [];
    for (const b of city.doc.buildings.all()) {
      const els = b.elements ?? [];
      parts += els.length;
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const p = els[i]!, q = els[j]!;
        if (elementsMeet(p, q)) meets.push(`building ${b.id}: ${p.kind} at ${(p.x / m(1)).toFixed(1)},${(p.y / m(1)).toFixed(1)} in ${q.kind} at ${(q.x / m(1)).toFixed(1)},${(q.y / m(1)).toFixed(1)}`);
      }
    }
    // A city's worth of yards was laid, or nothing was tested.
    console.log(`lotClash: ${parts} parts`);
    expect(parts).toBeGreaterThan(10_000);
    expect(meets.slice(0, 6), `${meets.length} parts in each other`).toEqual([]);
  });
});

describe('two parts of a lot far apart', () => {
  type Part = Parameters<typeof elementsMeet>[0];
  const part = (kind: Part['kind'], x: number, y: number, w: number, d: number, h: number, angle?: number): Part =>
    ({ id: 1, kind, x: m(x), y: m(y), facing: 0, w: m(w), d: m(d), z: 0, h: m(h), ...(angle ? { angle } : {}) });

  it('are told apart before any footprint, and a near one still meets, a sapling\'s trunk included', () => {
    // A sapling narrower than its trunk's square: the trunk runs 7.5 cm into the post 20 cm away
    expect(elementsMeet(part('tree', 0, 0, 0.1, 0.1, 3), part('bollard', 0.2, 0, 0.15, 0.15, 1))).toBe(true);
    // Turned boxes touching corner on: within the circles, decided by their plans.
    expect(elementsMeet(part('bench', 0, 0, 2, 1, 0.5, Math.PI / 4), part('bench', 1.3, 0, 1, 1, 0.5))).toBe(true);
    expect(elementsMeet(part('bench', 0, 0, 1.6, 0.5, 0.5), part('bench', 5, 5, 1.6, 0.5, 0.5))).toBe(false);
  });
});
