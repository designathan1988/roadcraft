import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';

import { blueprintByKey } from '@world/buildings/blueprints';
import { encodeRecords } from '@world/buildings/recordTable';
import { type Building, asBuildingId, cloneBuilding } from '@world/buildings/types';

/** A reader of a tile's record table keeps what it decoded in fast arrays, whichever row it reads first (a cell job reads rows deep in the table) */

setFlagsFromString('--allow-natives-syntax');
const dictionary = new Function('a', 'return %HasDictionaryElements(a)') as (a: unknown[]) => boolean;

/** Many buildings, each with strings, shapes and shared members of its own: the last row's ids lie far past the first's. */
function rows(n: number): Building[] {
  const out: Building[] = [];
  for (let i = 0; i < n; i++) {
    const b = { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), id: asBuildingId(i + 1), x: i, y: 0, rotation: 0 } as Building & Record<string, unknown>;
    const shared = { [`own${i}`]: `name ${i}` };
    b[`tag${i}`] = { first: shared, again: shared };
    out.push(b);
  }
  return out;
}

describe('a record table reader', () => {
  it('reads the last row first without its look-ups turning into dictionaries, and reads it back as written', () => {
    const list = rows(3000);
    const reader = encodeRecords(list).reader();
    const last = reader.record(list.length - 1);
    expect(JSON.stringify(last)).toBe(JSON.stringify(list.at(-1)));
    const kept = reader as unknown as { strings: unknown[]; shapes: unknown[]; nodes: unknown[] };
    expect([dictionary(kept.strings), dictionary(kept.shapes), dictionary(kept.nodes)]).toEqual([false, false, false]);
    expect(JSON.stringify(reader.record(0))).toBe(JSON.stringify(list[0]));
  });
});
