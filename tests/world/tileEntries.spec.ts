import { describe, expect, it } from 'vitest';
import { BuildingStore } from '@world/buildings/store';
import { LotStore } from '@world/lotStore';
import { ChangeJournal, TILE_LOADED } from '@world/changes';
import { generateBlock } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import type { Lot } from '@world/lots';
import { m } from '@world/units';

/** A TILE PUT IN OR TAKEN OUT IS ONE ENTRY OF ONE RECTANGLE AND ITS IDS (plan B8): not a rectangle for each building or lot */

const building = (id: number, x: number): Building => ({ ...generateBlock(m(10), m(10), 1), id: id as BuildingId, x, y: 0, rotation: 0 } as unknown as Building);
const lot = (id: number, x: number): Lot => ({ id, corners: [{ x, y: 0 }, { x: x + m(10), y: 0 }, { x: x + m(10), y: m(10) }, { x, y: m(10) }] } as unknown as Lot);

describe("a tile's entry in the diary", () => {
  it("holds its buildings' ids in one rectangle round them", () => {
    const journal = new ChangeJournal();
    const store = new BuildingStore(journal);
    store.placeAll([building(1, 0), building(2, m(100)), building(3, m(300))]);
    const entry = journal.since(0, ['buildings'])!.at(-1)!;
    expect(entry.ids).toEqual([1, 2, 3]);
    expect(entry.rects).toHaveLength(1);
    store.dropAll([1, 2, 3] as BuildingId[]);
    expect(journal.since(0, ['buildings'])!.at(-1)!.rects).toHaveLength(1);
  });

  it("holds its lots' ids in one rectangle round them", () => {
    const journal = new ChangeJournal();
    const store = new LotStore(journal);
    store.restore([lot(1, 0), lot(2, m(200))].map((l) => ({ id: l.id, value: l })), TILE_LOADED);
    const entry = journal.since(0, ['lots'])!.at(-1)!;
    expect(entry.ids).toEqual([1, 2]);
    expect(entry.rects).toHaveLength(1);
  });
});
