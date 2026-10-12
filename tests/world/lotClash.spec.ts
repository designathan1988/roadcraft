import { describe, expect, it } from 'vitest';

import { m } from '@world/units';
import { elementsMeet } from '@world/buildings/elements';
import { growCity } from './cityAudit';

/**
 * NO PART OF A LOT STANDS IN ANOTHER (Etapa 5a). The lot planner checked a
 * part against the building, the drive and the gate's way, never against
 * the parts already laid: in a generated city 2 949 stood in each other - a
 * bin in the rocks, a planter on a gate post, a shed's roof through a crown,
 * a bench in a bench, flowers inside a shed (2026-10-10). A footprint is a
 * part's own (`elementsMeet`); what stands on a surface, the boundary's
 * joints and planting under a crown or against a fence meet by design.
 */
describe('the parts of a generated city\'s lots', () => {
  it('never stand in each other', () => {
    const city = growCity({});
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
    expect(parts).toBeGreaterThan(40_000);
    expect(meets.slice(0, 6), `${meets.length} parts in each other`).toEqual([]);
  }, 600_000);
});
