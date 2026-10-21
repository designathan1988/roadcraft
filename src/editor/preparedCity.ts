import type { SerializedDoc } from '@world/doc';
import { RecordTable, encodeRecords } from '@world/buildings/recordTable';
import { migrateBuilding } from '@world/buildings/serialize';
import { type Building, settleBuilding } from '@world/buildings/types';

/** A WHOLE CITY MADE OFF THE PAGE (`cityGen.worker.ts`), ITS BUILDINGS ONE SHARED TABLE AS A TILE'S (`tileStore.ts` prepareTile): each migrated and settled where it is made (`settleBuilding`: made plain, its members interned), the page reading them from the table, each knowing its row */

/** DO NOT post a city's buildings as objects: the page held the message's clone and its migrated copy, walked and interned every record again on adopting it, and made a table of its own for each building the first time a job or a write asked for it (`refOf`): ~1.3 GB allocated opening the large city, 2026-10-20. */
export function prepareCity(data: SerializedDoc): { readonly data: SerializedDoc; readonly buildings: ArrayBufferLike } {
  const settled = new WeakSet<object>(), ids = new Set<number>();
  const buildings: Building[] = [];
  for (const raw of data.buildings ?? []) {
    const b = migrateBuilding(raw);
    // The first of an id, as the page's load keeps it (`BuildingStore.load`).
    if (!b || ids.has(b.id)) continue;
    ids.add(b.id);
    buildings.push(settleBuilding(b, settled));
  }
  return { data: { ...data, buildings: [] }, buildings: encodeRecords(buildings).buffer };
}

/** A city as the page opens it; `table`: its buildings' table (`prepareCity`), the document's source of truth as it is (`BuildingStore.loadSections`), null: its buildings are in `data`. */
export interface OpenedCity {
  readonly data: SerializedDoc;
  readonly table: ArrayBufferLike | null;
}

/** A prepared city as the page opens it: DO NOT decode its table here (every record an object, ~8 KB of heap a building): the document reads a row when asked. */
export function preparedCity(data: SerializedDoc, table: ArrayBufferLike): OpenedCity {
  return { data: { ...data, buildings: [] }, table };
}

/** How many buildings an opened city has, in its data or its table. */
export function openedBuildings(city: OpenedCity): number {
  return (city.data.buildings?.length ?? 0) + (city.table ? new RecordTable(city.table).rows : 0);
}
