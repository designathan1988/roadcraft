import { describe, expect, it } from 'vitest';
import { BuildingStore } from '@world/buildings/store';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';

/** A STORE THAT DOES NOT INTERN (`BuildingStore.intern`, a tile's generator): its records are the same, their members only not shared with other buildings' */

describe('a building store with interning off', () => {
  it('keeps the same records as one interning, its members its own', () => {
    const body = (): Omit<Building, 'id'> => ({ ...generateBody('residential', 1200, 900, 3), x: 10, y: 20, rotation: 0 } as unknown as Omit<Building, 'id'>);
    const interning = new BuildingStore(), plain = new BuildingStore();
    plain.intern = false;
    const a = [interning.add(body()), interning.add(body())];
    const b = [plain.add(body()), plain.add(body())];
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    // Interned, two alike buildings share their storeys; not interned, each keeps its own.
    expect(a[0]!.volumes[0]!.storeys).toBe(a[1]!.volumes[0]!.storeys);
    expect(b[0]!.volumes[0]!.storeys).not.toBe(b[1]!.volumes[0]!.storeys);
  });
});
