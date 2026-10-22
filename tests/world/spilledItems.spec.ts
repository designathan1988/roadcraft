import { describe, expect, it } from 'vitest';
import { generateBody } from '@world/buildings/blueprints';
import { SharedMembers } from '@world/buildings/intern';
import { RecordTable, TableWriter, encodeRecords, tableRecords } from '@world/buildings/recordTable';
import { SpilledItems } from '@world/buildings/spilledItems';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';

const house = (id: number, floors: number): Building =>
  ({ ...generateBody(id % 2 ? 'residential' : 'commercial', m(20), m(16), floors), id, x: m(30) * id, y: -0.5 * id, rotation: id / 7 }) as unknown as Building;
const text = (list: readonly Building[]): string => JSON.stringify(list);

describe('a table written a batch at a time', () => {
  it('reads back the records it was given, while written and once finished, its members shared across batches', () => {
    const all = Array.from({ length: 24 }, (_, i) => house(i + 1, 1 + (i % 5)));
    const expected = text(all);
    const writer = new TableWriter(true), shared = new SharedMembers();
    for (let at = 0; at < all.length; at += 5) {
      const batch = all.slice(at, at + 5).map((b) => structuredClone(b));
      shared.share(batch);
      writer.add(batch);
      shared.end();
      writer.keepOnly((node) => shared.keeps(node));
    }
    expect(text(Array.from({ length: writer.rows }, (_, row) => writer.read(row)))).toBe(expected);
    const table = writer.finish();
    expect(text(tableRecords(table.buffer))).toBe(expected);
    expect(Array.from(table.ids)).toEqual(all.map((b) => b.id));
    // Smaller than each batch written alone: what they have alike is written once.
    const alone = all.reduce((n, _, i) => (i % 5 ? n : n + encodeRecords(all.slice(i, i + 5).map((b) => structuredClone(b))).buffer.byteLength), 0);
    expect(table.buffer.byteLength).toBeLessThan(alone);
  });

  it('writes in one batch the very bytes encodeRecords writes', () => {
    const all = Array.from({ length: 6 }, (_, i) => house(i + 1, 2));
    const writer = new TableWriter();
    writer.add(all);
    expect(new Uint8Array(writer.finish().buffer)).toEqual(new Uint8Array(encodeRecords(all).buffer));
  });
});

describe('the buildings of a city being grown, the older in a table', () => {
  it('answers as a Map in a Map\'s order, the records spilled read back equal', () => {
    const items = new SpilledItems(), plain = new Map<BuildingId, Building>();
    const both = (id: number, b: Building): void => { items.set(id as BuildingId, b); plain.set(id as BuildingId, b); };
    for (let id = 1; id <= 10; id++) both(id, house(id, 2));
    const spilled = items.spill(3);
    expect(spilled.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(items.heldCount).toBe(3);
    // A spilled row written again keeps its place; one deleted and set again goes last.
    both(2, house(2, 6));
    items.delete(4 as BuildingId); plain.delete(4 as BuildingId);
    both(4, house(4, 1));
    items.delete(9 as BuildingId); plain.delete(9 as BuildingId);
    both(11, house(11, 3));
    items.spill(0);
    expect(items.size).toBe(plain.size);
    expect([...items.keys()]).toEqual([...plain.keys()]);
    expect(JSON.stringify([...items.values()])).toBe(JSON.stringify([...plain.values()]));
    expect(items.has(9 as BuildingId)).toBe(false);
    expect(items.get(9 as BuildingId)).toBeUndefined();
    // The same object while it is among the rows read last.
    expect(items.get(3 as BuildingId)).toBe(items.get(3 as BuildingId));
    expect(new RecordTable(encodeRecords([...items.values()]).buffer).rows).toBe(plain.size);
  });
});
