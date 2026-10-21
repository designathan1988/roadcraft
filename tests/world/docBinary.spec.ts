import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { setFlagsFromString, getHeapStatistics } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { History } from '@editor/history';
import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { isDocBinary } from '@world/docBinary';
import { tableIn } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';

/** THE MAP SAVED AS BINARY SECTIONS (`world/docBinary.ts`) AND UNDONE BY RECORD DIFFS (`MemberDiff`): a save loaded and saved again is the very same bytes (Factorio's rule, FFF #270), and the undo of 1,000 edits holds what they changed, not the records. */

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
const heap = (): number => { collect(); collect(); return getHeapStatistics().used_heap_size; };

/** The small city of seed 7 as the page opens it: its buildings in their table (`cooked/cities`, `prepareCity` of `buildSmallCityMap(7)`). */
function smallCity(): RoadDoc {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL('small-7.json.gz', dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL('small-7.table.gz', dir)));
  const city = preparedCity(data, tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const doc = new RoadDoc();
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: city.table!, whole: true });
  return doc;
}

const same = (a: ArrayBuffer, b: ArrayBuffer): boolean => a.byteLength === b.byteLength && Buffer.compare(new Uint8Array(a), new Uint8Array(b)) === 0;

describe('the map in binary sections', () => {
  it('saves, loads and saves again to the very same bytes, edited or not, and loads the very same map', () => {
    const doc = smallCity();
    const ids = [...doc.buildings.all()].slice(0, 6).map((b) => b.id);
    // Edited over its table: one replaced, one removed (its lot freed with it, as a demolition frees it), one added.
    doc.buildings.put({ ...doc.buildings.get(ids[0]!)!, name: 'Edited' });
    doc.buildings.remove(ids[1]!);
    for (const lot of [...doc.lotStore.all()].filter((l) => l.building === ids[1])) {
      const { building: _gone, ...free } = lot;
      doc.lotStore.restore([{ id: lot.id, value: free }], 'test');
    }
    const { id: _id, ...copy } = doc.buildings.get(ids[2]!)!;
    doc.buildings.add({ ...copy, x: copy.x + 5 });
    const first = doc.toBinary();
    expect(isDocBinary(first)).toBe(true);
    const loaded = RoadDoc.fromBinary(first);
    const second = loaded.toBinary();
    expect(same(first, second)).toBe(true);
    expect(same(RoadDoc.fromBinary(second).toBinary(), first)).toBe(true);
    // The canonical content, record for record and in the same order.
    expect(JSON.stringify(loaded.toJSON())).toBe(JSON.stringify(doc.toJSON()));
    expect(loaded.buildings.get(ids[0]!)!.name).toBe('Edited');
    expect(loaded.buildings.has(ids[1]!)).toBe(false);
    // No text of the whole map: the buildings are their table, a few bytes more than it.
    expect(first.byteLength).toBeLessThan(doc.toText().length);
  });

  it('saves a map opened from JSON (no table) the same way', () => {
    const doc = RoadDoc.fromJSON(smallCity().toJSON(), { repair: false });
    const first = doc.toBinary();
    expect(same(RoadDoc.fromBinary(first).toBinary(), first)).toBe(true);
    expect(JSON.stringify(RoadDoc.fromBinary(first).toJSON())).toBe(JSON.stringify(doc.toJSON()));
  });
});

describe('the undo of 1,000 edits', () => {
  it('holds what the edits changed, under 1 MB, and puts every building back as it was', () => {
    const doc = smallCity();
    const history = new History(2000, 96 * 1024 * 1024);
    const ids = [...doc.buildings.all()].slice(0, 100).map((b) => b.id);
    const before = JSON.stringify(ids.map((id) => doc.buildings.get(id)));
    const edit = (i: number): void => {
      const id = ids[i % ids.length]! as BuildingId;
      history.begin(doc);
      const b = doc.buildings.get(id)!;
      doc.buildings.put({ ...b, name: `Edit ${i}`, palette: (b.palette + 1) % 8 } as Building);
      history.end(doc);
    };
    for (let i = 0; i < 1000; i++) edit(i);
    // What the steps hold: the heap with them, less the heap once a copy of the history without them is all that is left.
    const withSteps = heap();
    const kept = { history };
    const steps = history.bytes;
    kept.history.clear();
    const held = withSteps - heap();
    console.log(`[undo] 1,000 edits: ${(steps / 1024).toFixed(1)} KB counted, ${(held / 1024).toFixed(1)} KB of heap`);
    expect(steps).toBeLessThan(1024 * 1024);
    expect(held).toBeLessThan(1024 * 1024);
    // Again, kept this time, to be undone.
    for (let i = 0; i < 1000; i++) edit(i + 1000);
    let undone = 0;
    while (history.undo(doc)) undone++;
    expect(undone).toBe(1000);
    // Back to the map as the first thousand edits left it: each building's last name of them, its palette ten turns on.
    const firstThousand = JSON.parse(before) as Building[];
    expect(ids.map((id) => doc.buildings.get(id)!.name)).toEqual(ids.map((_, k) => `Edit ${900 + k}`));
    expect(ids.map((id) => doc.buildings.get(id)!.palette)).toEqual(firstThousand.map((b) => (b.palette + 10) % 8));
    for (let i = 0; i < 1000; i++) history.redo(doc);
    expect(doc.buildings.get(ids[99]! as BuildingId)!.name).toBe('Edit 1999');
  }, 30_000);
});
