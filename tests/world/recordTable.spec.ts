import { describe, expect, it } from 'vitest';

import { blueprintByKey } from '@world/buildings/blueprints';
import { internMembers } from '@world/buildings/intern';
import { encodeRecords, readRecords, RecordTable } from '@world/buildings/recordTable';
import { type Building, asBuildingId, cloneBuilding } from '@world/buildings/types';

/** A tile's buildings as one typed table in shared memory (`recordTable.ts`) */

function building(id: number, key: string, x: number): Building {
  const b = { ...cloneBuilding(blueprintByKey(key)!.body as unknown as Building), id: asBuildingId(id), x, y: -x / 3, rotation: 0.25 * id };
  internMembers(b as unknown as Record<string, unknown>);
  return b;
}

describe('a record table', () => {
  const rows = [building(7, 'house', 10), building(8, 'house', 40.5), building(9, 'house', -3e9), building(10, 'house', 0.1)];
  (rows[3] as { name?: string }).name = 'Edifício Itália';
  (rows[2] as { decay?: number }).decay = -0;

  it('reads back every record as JSON keeps it, from any row and in any order', () => {
    const table = encodeRecords(rows);
    const back = table.reader();
    for (const i of [3, 0, 2, 1, 3]) expect(JSON.stringify(back.record(i))).toBe(JSON.stringify(rows[i]));
    expect(Object.is(new RecordTable(table.buffer).reader().record(2).decay, -0)).toBe(true);
  });

  it('holds the columns read without a record, and finds a row by id', () => {
    const table = new RecordTable(encodeRecords(rows).buffer);
    expect([...table.ids]).toEqual([7, 8, 9, 10]);
    expect(table.xs[2]).toBe(-3e9);
    expect(table.rotations[1]).toBe(2);
    expect(table.row(9)).toBe(2);
    expect(table.row(99)).toBe(-1);
  });

  it('writes a member the rows share once, and a reader makes it one object for all of them', () => {
    const one = encodeRecords(rows.slice(0, 1)).buffer.byteLength;
    const four = encodeRecords(rows).buffer.byteLength;
    expect(four).toBeLessThan(one * 2);
    const [a, b] = readRecords([{ buffer: encodeRecords(rows).buffer, row: 1 }, { buffer: encodeRecords(rows).buffer, row: 0 }]);
    expect(a!.volumes[0]!.storeys).not.toBe(b!.volumes[0]!.storeys);
    const shared = encodeRecords(rows).buffer;
    const [c, d] = readRecords([{ buffer: shared, row: 1 }, { buffer: shared, row: 0 }]);
    expect(c!.volumes[0]!.storeys[0]).toBe(d!.volumes[0]!.storeys[0]);
    expect(c).not.toBe(d);
  });

  it('reads a row whose shared members hold others met first in it, after a row that read them', () => {
    const storey = rows[0]!.volumes[0]!.storeys[0]!;
    const inner = { ...rows[0]!.volumes[0]!, storeys: [storey] };
    const a = { ...rows[0]!, id: asBuildingId(1), volumes: [inner, { ...inner, id: 99 }] } as Building;
    const b = { ...rows[1]!, id: asBuildingId(2), volumes: [{ ...inner, id: 7 }] } as Building;
    const c = { ...rows[2]!, id: asBuildingId(3), volumes: [inner] } as Building;
    const table = encodeRecords([a, b, c]);
    const reader = table.reader();
    for (const i of [2, 0, 1, 0]) expect(JSON.stringify(reader.record(i))).toBe(JSON.stringify([a, b, c][i]));
  });

  it('lives in shared memory, posted as a handle', () => {
    expect(encodeRecords(rows).buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});
