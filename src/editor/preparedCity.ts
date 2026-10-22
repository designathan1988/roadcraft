import type { SerializedDoc } from '@world/doc';
import { encodeRecords, tableRecords } from '@world/buildings/recordTable';
import { type SerializedBuilding, migrateBuilding } from '@world/buildings/serialize';
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

/** A city as the page opens it; `prepared`: its buildings read from their table (`preparedCity`), filed as they are (`RoadDoc.fromJSON` preparedBuildings). */
export interface OpenedCity {
  readonly data: SerializedDoc;
  readonly prepared: boolean;
}

/** A prepared city as the page opens it: its buildings read from their table, each knowing its row (`tableRecords`). */
export function preparedCity(data: SerializedDoc, table: ArrayBufferLike): OpenedCity {
  return { data: { ...data, buildings: tableRecords(table) as unknown as readonly SerializedBuilding[] }, prepared: true };
}
