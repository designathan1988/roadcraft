import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { blueprintByKey } from '@world/buildings/blueprints';
import { BuildingStore } from '@world/buildings/store';
import { type Building, type BuildingId, cloneBuilding } from '@world/buildings/types';
import { editBuilding, placeBuilding } from '@editor/buildings';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';

/**
 * The building store keeps the records it is handed, without copying them
 * (`store.ts`, OWNERSHIP): what it stores must still be what a copy was -
 * plain JSON data - and no record may change once stored, or the undo image,
 * the cloned documents and every per-record cache that keep records by
 * reference would read a building that is no longer there.
 */

/** The record as the old store kept it: a JSON round trip of what it was handed. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  Object.freeze(value);
}

function house(): Omit<Building, 'id'> {
  return { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), x: 0, y: 0, rotation: 0 };
}

describe('the building store owns the records it is handed', () => {
  it('keeps the record itself, made the plain data a copy would have been', () => {
    const store = new BuildingStore();
    const value = { ...house(), rotation: -0, name: undefined } as unknown as Omit<Building, 'id'>;
    value.volumes[0]!.x = -0;
    const volumes = value.volumes;
    const stored = store.add(value);
    // Not copied: the parts are the ones handed over.
    expect(stored.volumes).toBe(volumes);
    // As the JSON copy read: -0 is 0, an undefined member is gone (`'name' in`, spreads and keys see it).
    expect(Object.is(stored.rotation, 0)).toBe(true);
    expect(Object.is(stored.volumes[0]!.x, 0)).toBe(true);
    expect('name' in stored).toBe(false);
    expect(isDeepStrictEqual(stored, roundTrip(stored))).toBe(true);
    expect(store.toText()).toBe(JSON.stringify(store.toJSON()));
  });

  it('replaces a record with a new one, the old one untouched, the diary told', () => {
    const store = new BuildingStore();
    const first = store.add(house());
    const firstText = JSON.stringify(first);
    const serial = store.revision;
    store.put({ ...first, decay: 0.5, builtAt: -0 });
    const now = store.get(first.id)!;
    expect(now).not.toBe(first);
    // The unchanged parts are shared, read-only (`put({ ...stored, decay })`).
    expect(now.volumes).toBe(first.volumes);
    expect(Object.is(now.builtAt, 0)).toBe(true);
    // The record the store held before is as it was: an undo image holding it puts back that building.
    expect(JSON.stringify(first)).toBe(firstText);
    expect(new Set(store.changedSince(serial))).toEqual(new Set([first.id]));
    store.restore(first.id, first);
    expect(store.get(first.id)).toBe(first);
    expect(JSON.stringify(store.get(first.id))).toBe(firstText);
  });

  it('an edit works on a copy: the stored record never changes under it', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-200), y: 0 }).id, b = doc.addNode({ x: m(200), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    const ctx = { doc, net, groundAt: (): number => 0 };
    const placed = placeBuilding(ctx, blueprintByKey('house')!.body, { x: 0, y: m(40) }, 0);
    expect(placed.ok).toBe(true);
    const id = placed.id as BuildingId;
    const before = doc.buildings.get(id)!;
    deepFreeze(before);
    const text = JSON.stringify(before);
    const edited = editBuilding(ctx, id, (draft) => { draft.x += m(1); draft.palette = 3; return true; });
    expect(edited.ok).toBe(true);
    expect(JSON.stringify(before)).toBe(text);
    expect(doc.buildings.get(id)!.x).toBeCloseTo(before.x + m(1), 9);
  });

  it('a town grown lot by lot never writes a record once it is stored', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-260), y: 0 }).id, b = doc.addNode({ x: m(260), y: 0 }).id;
    const c = doc.addNode({ x: 0, y: m(-200) }).id, d = doc.addNode({ x: 0, y: m(200) }).id;
    doc.addSegment(a, b, 1);
    doc.addSegment(c, d, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const zones = [{ use: 'commercial', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'industrial', density: 'medium' }] as const;
    doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[i % zones.length]!));
    // Every record frozen the moment it is stored: a later write to it (or to a part it shares) throws.
    const store = doc.buildings;
    const add = store.add.bind(store), put = store.put.bind(store);
    store.add = (value) => { const stored = add(value); deepFreeze(stored); return stored; };
    store.put = (value) => { put(value); deepFreeze(store.get(value.id)); };
    const refused = new Set<number>();
    let grown = 0;
    for (let k = 0; k < 30; k++) {
      const id = growOnLot({ doc, net, groundAt: (x, y) => x * 0.03 - y * 0.05 }, refused, 0x5eed);
      if (id === null) { if (refused.size >= doc.lots.length) break; continue; }
      const fresh = doc.buildings.get(id as BuildingId)!;
      doc.buildings.put({ ...fresh, builtAt: k, decay: 0, lotPlan: LOT_PLAN_VERSION });
      grown++;
    }
    expect(grown).toBeGreaterThan(5);
    for (const record of doc.buildings.all()) expect(isDeepStrictEqual(record, roundTrip(record))).toBe(true);
    expect(doc.toText()).toBe(JSON.stringify(doc.toJSON()));
  });
});
