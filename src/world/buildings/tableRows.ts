import { RecordTable, type TableReader, readRow } from './recordTable';
import type { Building, BuildingId } from './types';

/** THE BUILDINGS OF A RECORD TABLE AS A READ-ONLY MAP BY ID, EACH RECORD DECODED WHEN READ (report "Arquitetura para cidades grandes", "A conta de memória"): the table is the source of truth, a record is a JS object only while someone reads or holds it. */

/** The records read by id kept alive, newest last: the selection, the inspector and the tools read the same few again and again. */
const RECENT = 2048;

/** DO NOT keep every record decoded (`tableRecords` did: ~8 KB of heap a building, the table ~1.3 KB outside it). A record read is the same object while anyone holds it (a `WeakRef` a row), so a reader that compares a held record with the store's sees what it saw when every record was an object; one nobody holds is collected and decoded again when asked. */
export class TableRows implements ReadonlyMap<BuildingId, Building> {
  readonly table: RecordTable;
  private readonly reader: TableReader;
  /** The ids sorted, and each one's row: a row found by binary search, 12 bytes a building, no `Map` entry each. */
  private readonly sortedIds: Float64Array;
  private readonly sortedRows: Uint32Array;
  /** Each row's record while it is held somewhere (WeakRef: MDN "WeakRef"); filled once to its length, never grown from empty (a sparse array turns into a dictionary). */
  private readonly alive: (WeakRef<Building> | undefined)[];
  /** The rows last read by id (`get`), held: the working set near the player, never the whole walk of `values`. */
  private readonly recent = new Map<number, Building>();
  /** Told each record decoded (the store marks it settled: `BuildingStore.settled`). */
  onRead: ((b: Building) => void) | null = null;

  constructor(buffer: ArrayBufferLike) {
    this.table = new RecordTable(buffer);
    // Its shared members held weakly: the table lives as long as the map, and a walk of the map would leave every one decoded.
    this.reader = this.table.reader(true);
    const n = this.table.rows, ids = this.table.ids;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => ids[a]! - ids[b]!);
    this.sortedRows = order;
    this.sortedIds = new Float64Array(n);
    for (let i = 0; i < n; i++) this.sortedIds[i] = ids[order[i]!]!;
    this.alive = new Array<WeakRef<Building> | undefined>(n).fill(undefined);
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  get buffer(): ArrayBufferLike {
    return this.table.buffer;
  }

  get size(): number {
    return this.table.rows;
  }

  /** The row of an id; -1 when the table has none. */
  rowOf(id: number): number {
    const ids = this.sortedIds;
    let lo = 0, hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, v = ids[mid]!;
      if (v === id) return this.sortedRows[mid]!;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /** The id of a row. */
  idAt(row: number): BuildingId {
    return this.table.ids[row]! as BuildingId;
  }

  /** A row's record: the one held somewhere if any, else decoded now. */
  record(row: number): Building {
    const held = this.alive[row]?.deref();
    if (held) return held;
    const b = readRow(this.reader, row);
    this.alive[row] = new WeakRef(b);
    this.onRead?.(b);
    return b;
  }

  /** How many rows' records are decoded and held somewhere now (the LRU of `get` among them): what the table saves is what is not. */
  held(): number {
    let n = 0;
    for (const ref of this.alive) if (ref?.deref() !== undefined) n++;
    return n;
  }

  get(id: BuildingId): Building | undefined {
    const row = this.rowOf(id);
    if (row < 0) return undefined;
    const b = this.record(row);
    const recent = this.recent;
    recent.delete(row);
    recent.set(row, b);
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!);
    return b;
  }

  has(id: BuildingId): boolean {
    return this.rowOf(id) >= 0;
  }

  *keys(): MapIterator<BuildingId> {
    const ids = this.table.ids;
    for (let row = 0; row < ids.length; row++) yield ids[row]! as BuildingId;
  }

  *values(): MapIterator<Building> {
    for (let row = 0; row < this.table.rows; row++) yield this.record(row);
  }

  *entries(): MapIterator<[BuildingId, Building]> {
    for (let row = 0; row < this.table.rows; row++) yield [this.idAt(row), this.record(row)];
  }

  [Symbol.iterator](): MapIterator<[BuildingId, Building]> {
    return this.entries();
  }

  forEach(visit: (value: Building, key: BuildingId, map: ReadonlyMap<BuildingId, Building>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}
