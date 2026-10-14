import { describe, expect, it } from 'vitest';

import { createCoverIndex } from '@render/buildings/layerCells';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { type Building, asBuildingId } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * The plant cull's index of where the buildings stand, filed a building at a
 * time (`set`, `remove`): it answers as the whole town filed again would, and
 * its version moves only when a footprint does. Filing the whole town for
 * one building was the layer reading every building at every change
 * (docs/AUDITORIA-2026-10-14.md A5).
 */
function building(id: number, x: number, y: number, rotation = 0): Building {
  const bp = BLUEPRINTS[id % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: asBuildingId(id), x, y, rotation } as Building;
}

describe('the cover index, a building at a time', () => {
  it('answers as the town filed again', () => {
    let seed = 3;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const town = new Map<number, Building>();
    const live = createCoverIndex();
    const span = m(400);
    let covered = 0;
    for (let step = 0; step < 120; step++) {
      const id = 1 + Math.floor(rand() * 20);
      if (town.has(id) && rand() < 0.3) {
        town.delete(id);
        live.remove(asBuildingId(id));
      } else {
        const b = building(id, rand() * span, rand() * span, rand() * Math.PI);
        town.set(id, b);
        live.set(b);
      }
      if (step % 10 !== 9) continue;
      const whole = createCoverIndex();
      whole.index(town.values());
      for (let i = 0; i < 400; i++) {
        const x = rand() * span * 1.2 - span * 0.1, y = rand() * span * 1.2 - span * 0.1;
        expect(live.covers(x, y)).toBe(whole.covers(x, y));
        if (whole.covers(x, y)) covered++;
      }
    }
    expect(covered).toBeGreaterThan(30);
  });

  it('moves its version only when a footprint moves', () => {
    const index = createCoverIndex();
    const a = building(1, 0, 0);
    index.index([a]);
    const v = index.version;
    // The same footprint again (a building repainted): nothing to cull again.
    index.set({ ...a, palette: a.palette + 1 });
    expect(index.version).toBe(v);
    index.set(building(1, m(50), 0));
    expect(index.version).toBe(v + 1);
    index.remove(asBuildingId(1));
    expect(index.version).toBe(v + 2);
    expect(index.covers(m(55), m(5))).toBe(false);
    index.remove(asBuildingId(1));
    expect(index.version).toBe(v + 2);
  });
});
