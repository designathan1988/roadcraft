import { describe, expect, it } from 'vitest';
import type { Aabb } from '@core/aabb';
import { BuildingGrid } from '@world/buildings/grid';
import { BuildingStore } from '@world/buildings/store';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, type BuildingId, asBuildingId, cloneBuilding } from '@world/buildings/types';

/** A WORKING COPY'S BUILDINGS BY PLACE (`BuildingGrid.over`, `BuildingStore.forkFrom`), and the undo's image of the store (`toJSON`) */

interface Item { readonly id: BuildingId; readonly x: number; readonly y: number; readonly r: number }
const boxOf = (b: Item): Aabb => ({ minX: b.x - b.r, minY: b.y - b.r, maxX: b.x + b.r, maxY: b.y + b.r });

/** A small seeded random, so a failure repeats. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
}

function house(x: number, y: number): Omit<Building, 'id'> {
  return { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), x, y, rotation: 0 };
}

describe('a grid over another', () => {
  it('answers as a grid made of the copy, filing only what was written', () => {
    const rnd = random(11);
    let next = 1;
    const make = (): Item => ({ id: asBuildingId(next++), x: rnd() * 1000 - 500, y: rnd() * 1000 - 500, r: 2 + rnd() * 90 });
    const items = new Map<BuildingId, Item>();
    for (let i = 0; i < 600; i++) { const b = make(); items.set(b.id, b); }
    const base = new BuildingGrid(items.values(), boxOf);
    let filed = 0;
    const counted = (b: Item): Aabb => { filed++; return boxOf(b); };
    const over = BuildingGrid.over(new BuildingGrid(items.values(), counted));
    filed = 0;
    // The copy's own records, in the order a map keeps them (replaced in place, added last).
    const copy = new Map(items);
    let writes = 0;
    for (let k = 0; k < 120; k++) {
      const pick = rnd();
      const ids = [...copy.keys()];
      const id = ids[Math.floor(rnd() * ids.length)]!;
      if (pick < 0.4) { const b = make(); copy.set(b.id, b); over.insert(b); writes++; }
      else if (pick < 0.7) { const b = { ...copy.get(id)!, x: rnd() * 1000 - 500 }; copy.set(id, b); over.update(b); writes++; }
      else { copy.delete(id); over.delete(id); }
    }
    // Only what was written was filed: not the map again.
    expect(filed).toBe(writes);
    const fresh = new BuildingGrid(copy.values(), boxOf);
    for (let q = 0; q < 400; q++) {
      const x = rnd() * 1200 - 600, y = rnd() * 1200 - 600, w = rnd() * (q % 4 === 0 ? 300 : 40);
      expect(over.near(x, y, x + w, y + w)).toEqual(fresh.near(x, y, x + w, y + w));
      const rects = [[x, y, x + w, y + w], [y, x, y + w, x + w]] as const;
      const meets = (id: BuildingId): boolean => id % 3 !== 0;
      expect(over.nearAny(rects, 5, meets)).toEqual(fresh.nearAny(rects, 5, meets));
    }
    // The base as it was.
    const untouched = new BuildingGrid(items.values(), boxOf);
    expect(base.near(-600, -600, 600, 600)).toEqual(untouched.near(-600, -600, 600, 600));
  });

  it('serves a working copy that wrote, without filing the original again', () => {
    const store = new BuildingStore();
    for (let i = 0; i < 40; i++) store.add(house((i % 8) * 40, Math.floor(i / 8) * 40));
    // The original asked by place: its grid made.
    store.near(0, 0, 10, 10);
    const work = new BuildingStore();
    work.forkFrom(store);
    const moved = { ...store.get(asBuildingId(3))!, x: 1000, y: 1000 };
    work.put(moved);
    work.remove(asBuildingId(5));
    const added = work.add(house(1010, 990));
    // The same answers as a store of the copy's records.
    const plain = new BuildingStore();
    for (const b of work.all()) plain.restore(b.id, b);
    for (const [x0, y0, x1, y1] of [[-50, -50, 400, 400], [990, 980, 1020, 1020], [60, 20, 90, 50]] as const) {
      expect(work.near(x0, y0, x1, y1).map((b) => b.id)).toEqual(plain.near(x0, y0, x1, y1).map((b) => b.id));
    }
    expect(work.near(990, 980, 1020, 1020).map((b) => b.id)).toEqual([moved.id, added.id]);
    // The original as it was.
    expect(store.near(990, 980, 1020, 1020)).toEqual([]);
    expect(store.near(150, 0, 170, 10).map((b) => b.id)).toContain(asBuildingId(5));
  });

  it('writes the undo image with the records themselves, not copies', () => {
    const store = new BuildingStore();
    const a = store.add(house(0, 0)), b = store.add(house(50, 0));
    const image = store.toJSON();
    expect(image[0]).toBe(a);
    expect(image[1]).toBe(b);
    // The same text as before.
    expect(JSON.stringify(image)).toBe(store.toText());
    // Put back into another store, the same buildings.
    const other = new BuildingStore();
    other.load(image);
    expect(other.toText()).toBe(store.toText());
  });
});
