import { describe, expect, it } from 'vitest';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import { interiorAt } from '@world/buildings/interior';
import { roomsOfStorey } from '@render/buildings/roomBehind';
import type { Building } from '@world/buildings/types';

/** A FLOOR IS FURNISHED ONCE A TYPE: THE LEVELS OF ONE TYPE HOLD WHAT EACH WOULD HAVE BEEN FURNISHED WITH ON ITS OWN (`interior.ts` `floorType`) */

/** The tower over its podium, its storeys one record from the second to the one under the top, as a tile's decoded records share them. */
function tower(id: number): Building {
  const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[4]!.body)), id, x: 0, y: 0, rotation: 0 } as Building;
  const t = b.volumes[1]!;
  t.storeys = t.storeys.map((s, k) => (k > 0 && k < t.storeys.length - 1 ? t.storeys[1]! : s));
  return b;
}

describe('floors furnished by type', () => {
  it('shares one type between alike levels, each the floor it would be alone', () => {
    const shared = tower(1);
    // Every storey a record of its own: each level furnished on its own.
    const alone = { ...JSON.parse(JSON.stringify(shared)), id: 1 } as Building;
    const top = Math.max(...shared.volumes.map((v) => v.base + v.storeys.length));
    for (let level = 0; level < top; level++) expect(interiorAt(shared, level)).toEqual(interiorAt(alone, level));
    expect(interiorAt(shared, 4).furniture).toBe(interiorAt(shared, 6).furniture);
    expect(interiorAt(alone, 4).furniture).not.toBe(interiorAt(alone, 6).furniture);
    // Ground, first and last storey of a block are types of their own.
    expect(interiorAt(shared, 0).furniture).not.toBe(interiorAt(shared, 4).furniture);
    expect(interiorAt(shared, top - 1).furniture).not.toBe(interiorAt(shared, 4).furniture);
  });

  it('keeps the player\'s own arrangement to its level', () => {
    const b = { ...tower(2), furnishing: { 5: [{ kind: 'sofa', x: 6, y: 6, angle: 0 }] } } as Building;
    expect(interiorAt(b, 5).furniture.map((f) => f.kind)).toEqual(['sofa']);
    expect(interiorAt(b, 6).furniture.length).toBeGreaterThan(1);
  });

  it('looks at a pane alike once and gives what it would alone', () => {
    const b = tower(3);
    const v = b.volumes[1]!;
    const look = roomsOfStorey(b, v, interiorAt(b, 4), 4);
    const fresh = roomsOfStorey(b, v, interiorAt(b, 4), 4);
    const a = look(v.x, v.y, 1, 0, 0, -1, 1.5, 1.2, 2.6);
    expect(look(v.x, v.y, 1, 0, 0, -1, 1.5, 1.2, 2.6)).toBe(a);
    expect(a).toEqual(fresh(v.x, v.y, 1, 0, 0, -1, 1.5, 1.2, 2.6));
  });
});
