import { BuildingItems } from './items';
import { RecordTable, encodeRecords, tableRecords } from './recordTable';
import { TableRows } from './tableRows';
import type { Building, BuildingId } from './types';

/** A STORE'S BUILDINGS AS BUFFERS, NEVER AS OBJECTS (the save's sections, the simulation's map, the undo of a whole map): the table they were opened from, as it is (shared, never copied), and what was written over it - the ids deleted, the records replaced in place and those added after, each kind one table. Read back in the store's order (`BuildingItems`). */
export interface BuildingSections {
  readonly base: ArrayBufferLike | null;
  /** The ids of the table deleted (set again: in `added`). */
  readonly gone: Float64Array;
  readonly replaced: ArrayBufferLike | null;
  readonly added: ArrayBufferLike | null;
}

const tableOf = (records: Iterable<Building>): ArrayBufferLike | null => {
  const list = [...records];
  return list.length ? encodeRecords(list).buffer : null;
};

/** The sections of a store's buildings: the table shared as it is, only the records written encoded (`encodeRecords`). A map that is no table (a working copy's `ForkMap`): every record, added. */
export function sectionsOf(items: ReadonlyMap<BuildingId, Building>): BuildingSections {
  if (items instanceof BuildingItems) {
    const { gone, replaced, added } = items.writes();
    return { base: items.table?.buffer ?? null, gone: Float64Array.from(gone), replaced: tableOf(replaced.values()), added: tableOf(added.values()) };
  }
  return { base: null, gone: new Float64Array(0), replaced: null, added: tableOf(items.values()) };
}

/** The store's items read back from their sections: the table read when asked (`TableRows`), the records written decoded now (few). */
export function itemsOfSections(s: BuildingSections, onRead: ((b: Building) => void) | null): BuildingItems {
  const base = s.base ? new TableRows(s.base) : null;
  if (base) base.onRead = onRead;
  const written = (buffer: ArrayBufferLike | null): Building[] => {
    const list = buffer ? tableRecords(buffer) : [];
    if (onRead) for (const b of list) onRead(b);
    return list;
  };
  return BuildingItems.over(base, s.gone as unknown as Iterable<BuildingId>, written(s.replaced), written(s.added));
}

/** How many buildings the sections hold. */
export function sectionsSize(s: BuildingSections): number {
  const rows = (buffer: ArrayBufferLike | null): number => (buffer ? new RecordTable(buffer).rows : 0);
  return rows(s.base) - s.gone.length + rows(s.added);
}

/** The bytes the sections hold. */
export function sectionsBytes(s: BuildingSections): number {
  return (s.base?.byteLength ?? 0) + s.gone.byteLength + (s.replaced?.byteLength ?? 0) + (s.added?.byteLength ?? 0);
}

/** Every record of the sections in the store's order, one at a time (a worker's copy: `sim/agents/trafficBuildings.ts`): DO NOT hold them all - what is worked out of each goes with it. */
export function* eachSectionRecord(s: BuildingSections): Generator<Building, void, void> {
  const replaced = new Map<number, Building>();
  if (s.replaced) for (const b of tableRecords(s.replaced)) replaced.set(b.id, b);
  const gone = new Set<number>(s.gone);
  if (s.base) {
    const table = new RecordTable(s.base);
    const reader = table.reader();
    for (let row = 0; row < table.rows; row++) {
      const id = table.ids[row]!;
      if (gone.has(id)) continue;
      yield replaced.get(id) ?? reader.record(row);
    }
  }
  if (s.added) {
    const table = new RecordTable(s.added);
    const reader = table.reader();
    for (let row = 0; row < table.rows; row++) yield reader.record(row);
  }
}
