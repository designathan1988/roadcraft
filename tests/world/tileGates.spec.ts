import { describe, expect, it } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { generateBlock } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { TILE, tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';

/** A TILE'S GATES KEPT WHILE NONE OF ITS BUILDINGS CHANGED (plan B3 b): a write hands back the gates it came with, not every building's worked out again */

function tile(i: number, gates: readonly number[]): TileRecords {
  const key = tileKey(i, 0), base = tileIdBase(key);
  const building = { ...generateBlock(m(10), m(10), 1), id: base, x: i * TILE + m(100), y: m(100), rotation: 0 } as unknown as Building;
  return {
    key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [],
    buildings: [building] as never, lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [], gates,
    next: { node: base, segment: base, pole: base, span: base, building: base + 1, lot: base, landscape: base, barrier: base },
  };
}

describe("a tile's gates", () => {
  it('are the ones it came with while no building of it changed, and worked out again once one did', () => {
    const doc = new RoadDoc();
    // Gates no building of it has: kept, they are handed back as they came; worked out, they would not be.
    const kept = [1, 2, 3, 4];
    const here = tile(0, kept), there = tile(3, [9, 9, 9, 9]);
    doc.loadTile(here);
    doc.loadTile(there);
    expect(doc.tileRecords(here.key, 1).gates).toEqual(kept);
    // A building of another tile edited: these stay.
    const far = doc.buildings.get(tileIdBase(there.key) as BuildingId)!;
    doc.buildings.put({ ...far, rotation: 0.5 });
    expect(doc.tileRecords(here.key, 1).gates).toEqual(kept);
    // One of its own edited: worked out from its buildings now.
    const own = doc.buildings.get(tileIdBase(here.key) as BuildingId)!;
    doc.buildings.put({ ...own, rotation: 0.5 });
    expect(doc.tileRecords(here.key, 1).gates).not.toEqual(kept);
  });
});
