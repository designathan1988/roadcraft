import type { SerializedDoc } from '@world/doc';
import { RecordTable, TableWriter, encodeRecords } from '@world/buildings/recordTable';
import type { SharedMembers } from '@world/buildings/intern';
import { migrateBuilding } from '@world/buildings/serialize';
import { type Building, settleBuilding } from '@world/buildings/types';

/** A WHOLE CITY MADE OFF THE PAGE (`cityGen.worker.ts`), ITS BUILDINGS ONE SHARED TABLE AS A TILE'S (`tileStore.ts` prepareTile): each migrated and settled where it is made (`settleBuilding`: made plain, its members interned), the page reading them from the table, each knowing its row */

/** A city's document without its buildings, and their table (`prepareCity`, `PreparedCityWriter`). */
export interface PreparedCity {
  readonly data: SerializedDoc;
  readonly buildings: ArrayBufferLike;
}

/** DO NOT post a city's buildings as objects: the page held the message's clone and its migrated copy, walked and interned every record again on adopting it, and made a table of its own for each building the first time a job or a write asked for it (`refOf`): ~1.3 GB allocated opening the large city, 2026-10-20. */
export function prepareCity(data: SerializedDoc): PreparedCity {
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

/**
 * A CITY'S BUILDINGS PREPARED AS `prepareCity` PREPARES THEM, A BATCH AT A TIME AS THEY ARE MADE (`smallCityMap.ts` buildCityTable): each
 * migrated, the first of an id kept, settled and written to the page's table (`TableWriter`), the records let go. The same records as
 * `prepareCity`'s table (the members a building shares with others written once a batch, not once a city: the same values).
 */
export class PreparedCityWriter {
  private readonly table = new TableWriter(true);
  private readonly ids = new Set<number>();

  /** `shared`: the members the city's buildings have alike, kept across batches (`SharedMembers`): each written once while it is met, as `prepareCity`'s interned members were. The growth's table shares it (`SpilledItems`): a member its records made canonical is found here by identity, not hashed again. Each batch ended by its owner (`endBatch`). */
  constructor(private readonly shared: SharedMembers) {}

  /** The batch of members shared ended (`SharedMembers.end`): the table keeps as nodes only the members kept. */
  endBatch(): void {
    this.table.keepOnly((node) => this.shared.keeps(node));
  }

  /** The next records of the city, in its order. */
  add(batch: readonly Building[]): void {
    const settled = new WeakSet<object>(), rows: Building[] = [];
    for (const raw of batch) {
      const b = migrateBuilding(raw);
      if (!b || this.ids.has(b.id)) continue;
      this.ids.add(b.id);
      rows.push(settleBuilding(b, settled, undefined, false));
    }
    // What the records have alike written once (`SharedMembers`). DO NOT `intern` them: its `WeakRef`s hold every member of every record until the generation's task ends.
    this.shared.share(rows);
    this.table.add(rows);
  }

  /** The table of every record added. */
  finish(): ArrayBufferLike {
    return this.table.finish().buffer;
  }
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
