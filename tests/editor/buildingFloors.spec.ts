import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blueprintByKey } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { placeBuilding } from '@editor/buildings';
import { BuildingFloors } from '@editor/buildingFloors';
import { m } from '@world/units';

/**
 * The Builder's floors (`editor/buildingFloors.ts`): a floor is measured
 * again only when the diary says something it reads changed - its record,
 * the land or the roads near it - never because something changed anywhere.
 */
function town(): { doc: RoadDoc; near: Building; far: Building } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  const ctx = { doc, net, groundAt: (): number => 0 };
  const put = (x: number): Building => {
    const result = placeBuilding(ctx, blueprintByKey('house')!.body, { x, y: 0 }, 0, 'house');
    expect(result.ok, String(result.problem)).toBe(true);
    return doc.buildings.get(result.id as BuildingId)!;
  };
  return { doc, near: put(0), far: put(m(2000)) };
}

describe('the Builder floors', () => {
  it('measures again only the buildings an edit reached', () => {
    const { doc, near, far } = town();
    const floors = new BuildingFloors();
    let ground = 0;
    const read: number[] = [];
    const groundAt = (x: number): number => { read.push(x); return ground; };
    floors.floorOf(doc, near, groundAt);
    floors.floorOf(doc, far, groundAt);

    // A hill dabbed by the near one: its floor follows; the far one is not read again.
    ground = m(3);
    doc.addTerrainStamp({ x: 0, y: 0, radius: m(30), strength: 3, mode: 'raise' });
    read.length = 0;
    expect(floors.floorOf(doc, far, groundAt)).toBe(floors.floorOf(doc, far, () => 0));
    expect(read.length).toBe(0);
    expect(floors.floorOf(doc, near, groundAt)).toBeGreaterThan(m(2.9));
    expect(read.length).toBeGreaterThan(0);

    // The far building's own record changed: only it is measured again.
    doc.buildings.put({ ...far });
    read.length = 0;
    floors.floorOf(doc, near, groundAt);
    expect(read.length).toBe(0);
    floors.floorOf(doc, far, groundAt);
    expect(read.length).toBeGreaterThan(0);
  });
});
