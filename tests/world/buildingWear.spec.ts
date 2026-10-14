import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { DocImage } from '@world/docImage';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, cloneBuilding } from '@world/buildings/types';

/**
 * A building's wear (`Building.decay`) changes a tenth at a time, every few
 * seconds somewhere in a town, and on an explosion. It is no change of the
 * building's shape, place or use: written as one (`buildings`), it made every
 * product derived from the buildings' shape - walls, bays, yards, places,
 * grading, the camera's solids - work the town out again each time
 * (`BuildingStore.wear`).
 */

function house(x: number): Omit<Building, 'id'> {
  return { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), x, y: 0, rotation: 0 };
}

describe("a building's wear", () => {
  it('is written as wear: the shape revision and the shape readers see nothing', () => {
    const doc = new RoadDoc();
    const a = doc.buildings.add(house(0));
    doc.buildings.add(house(100));
    const shape = doc.buildings.revision;
    const wear = doc.buildings.wearRevision;

    doc.buildings.wear(a.id, 0.3);

    expect(doc.buildings.revision).toBe(shape);
    expect(doc.buildings.changedSince(shape)).toEqual([]);
    expect(doc.changes.since(shape, ['buildings'])).toEqual([]);
    expect(doc.buildings.wearRevision).toBeGreaterThan(wear);
    const entries = doc.changes.since(wear, ['buildingWear'])!;
    expect(entries.flatMap((e) => e.ids ?? [])).toEqual([a.id]);
    expect(entries[0]!.rects).not.toBeNull();
  });

  it('keeps everything of the record but the wear, its parts shared', () => {
    const doc = new RoadDoc();
    const a = doc.buildings.add(house(0));
    doc.buildings.wear(a.id, 0.5);
    const now = doc.buildings.get(a.id)!;
    expect(now.decay).toBe(0.5);
    expect(now).not.toBe(a);
    expect(now.volumes).toBe(a.volumes);
    expect({ ...now, decay: a.decay }).toEqual(a);
  });

  it('writes nothing when the wear is the same', () => {
    const doc = new RoadDoc();
    const a = doc.buildings.add(house(0));
    doc.buildings.wear(a.id, 0.2);
    const wear = doc.buildings.wearRevision;
    doc.buildings.wear(a.id, 0.2);
    expect(doc.buildings.wearRevision).toBe(wear);
  });

  it('reaches what saves and undoes the document', () => {
    const doc = new RoadDoc();
    const a = doc.buildings.add(house(0));
    const image = new DocImage(doc);
    doc.buildings.wear(a.id, 0.7);
    const patch = image.commit(doc)!;
    expect(patch).not.toBeNull();
    const record = patch.records.find((r) => r.part === 'buildings' && r.id === a.id)!;
    expect((record.after as Building).decay).toBe(0.7);
    expect((record.before as Building).decay ?? 0).toBe(a.decay ?? 0);
  });

  it('finds the buildings round a place by place, as the whole store would', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 40; i++) doc.buildings.add(house((i % 8) * 60 - 200));
    const [x, y, r] = [10, 0, 75];
    const near = doc.buildings.near(x - r, y - r, x + r, y + r).filter((b) => Math.hypot(b.x - x, b.y - y) <= r);
    const all = [...doc.buildings.all()].filter((b) => Math.hypot(b.x - x, b.y - y) <= r);
    expect(near.map((b) => b.id)).toEqual(all.map((b) => b.id));
  });
});
