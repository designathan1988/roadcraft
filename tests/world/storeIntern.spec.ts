import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { BuildingStore } from '@world/buildings/store';
import type { Building } from '@world/buildings/types';

/** A store thrown away once written out shares nothing (`store.ts` `internShared`): the same records, none of the walk. */

const body = (x: number): Omit<Building, 'id'> => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[3]!.body)), x, y: 0, rotation: 0 });

describe('a building store', () => {
  it('shares the members alike of its records, or not, the records the same either way', () => {
    const shared = new BuildingStore(), apart = new BuildingStore();
    apart.internShared = false;
    const [a, b] = [shared.add(body(0)), shared.add(body(30))];
    const [c, d] = [apart.add(body(0)), apart.add(body(30))];
    // Alike storeys: one object in the store that shares, two in the one that does not.
    expect(a.volumes[0]!.storeys[1]).toBe(b.volumes[0]!.storeys[1]);
    expect(c.volumes[0]!.storeys[1]).not.toBe(d.volumes[0]!.storeys[1]);
    expect(JSON.stringify([c, d])).toBe(JSON.stringify([a, b]));
  });
});
