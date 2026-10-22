import { SharedMembers } from './intern';
import { TableWriter } from './recordTable';
import type { Building, BuildingId } from './types';

/** The records decoded from the table kept as objects, the newest read last: a grown building's neighbours are read again and again while its block grows (`growth/zoning.ts` neighbourStoreys, nearSignatures), each the same object while it is held here. */
const RECENT = 1024;

/**
 * THE BUILDINGS OF A CITY BEING GROWN, THE OLDER ONES IN A TABLE (`TableWriter`), NOT AS OBJECTS (`editor/smallCityMap.ts` buildCityTable):
 * a `Map` to the store (`BuildingStore.spillToTable`), in a `Map`'s order (the table's rows in the order they were added, then the records
 * still held; a row set again keeps its place). `spill` moves all but the newest records into the table, each record read back from it
 * decoded when asked (JSON-equal to the record written: settled records, `settleBuilding`). DO NOT hold every record of a large city as
 * an object: ~20 KB of JS heap a building, 160,000 buildings took the city's worker to 5.6 GB, past the V8 cage it shares with its page
 * (2026-10-22).
 */
export class SpilledItems implements Map<BuildingId, Building> {
  /** The records spilled, in the order they were added. */
  private readonly table = new TableWriter(true);
  /** Each spilled id's row. */
  private readonly rowOf = new Map<BuildingId, number>();
  /** The records not spilled yet, in the order they were added. */
  private readonly held = new Map<BuildingId, Building>();
  /** Spilled rows given another record since (in place, as a `Map` keeps a key set again). */
  private readonly over = new Map<BuildingId, Building>();
  /** Spilled rows deleted (one set again after is in `held`). */
  private readonly gone = new Set<BuildingId>();
  /** The rows decoded last, held (`RECENT`). */
  private readonly recent = new Map<BuildingId, Building>();
  /** Spilled rows read now (not gone, not written again past them). */
  private spilledLive = 0;

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  /** How many records are held as objects (not spilled). */
  get heldCount(): number {
    return this.held.size;
  }

  /** `shared`: what the records spilled have alike (`SharedMembers`), the batch ended by whoever passes it (`endBatch`) - the page's table shares it (`editor/preparedCity.ts`); none: its own, each spill a batch. */
  constructor(shared?: SharedMembers) {
    this.shared = shared ?? new SharedMembers();
    this.ownShared = !shared;
  }

  private readonly shared: SharedMembers;
  private readonly ownShared: boolean;

  /** The batch of members shared ended (`SharedMembers.end`): the table keeps as nodes only the members kept. */
  endBatch(): void {
    this.table.keepOnly((node) => this.shared.keeps(node));
  }

  /** All but the newest `keep` records held moved into the table, in the order they were added; returned, for whoever writes them elsewhere too (the page's table, `buildCityTable`). */
  spill(keep: number): Building[] {
    const out: Building[] = [];
    let left = this.held.size - keep;
    for (const b of this.held.values()) {
      if (left-- <= 0) break;
      out.push(b);
    }
    if (!out.length) return out;
    const first = this.table.rows;
    // What the records have alike written once (`SharedMembers`: equal values, the records' JSON the same).
    this.shared.share(out);
    this.table.add(out);
    if (this.ownShared) { this.shared.end(); this.endBatch(); }
    out.forEach((b, i) => {
      this.held.delete(b.id);
      // A spilled id deleted before and set again: its old row stays gone, the new one is read.
      this.gone.delete(b.id);
      this.rowOf.set(b.id, first + i);
    });
    this.spilledLive += out.length;
    return out;
  }

  private spilled(key: BuildingId): boolean {
    return this.rowOf.has(key) && !this.gone.has(key);
  }

  private decoded(key: BuildingId, row: number): Building {
    let b = this.recent.get(key);
    if (b) {
      this.recent.delete(key);
    } else {
      b = this.table.read(row);
      if (this.recent.size >= RECENT) this.recent.delete(this.recent.keys().next().value!);
    }
    this.recent.set(key, b);
    return b;
  }

  get size(): number {
    return this.held.size + this.spilledLive;
  }

  get(key: BuildingId): Building | undefined {
    const held = this.held.get(key);
    if (held !== undefined) return held;
    if (!this.spilled(key)) return undefined;
    return this.over.get(key) ?? this.decoded(key, this.rowOf.get(key)!);
  }

  has(key: BuildingId): boolean {
    return this.held.has(key) || this.spilled(key);
  }

  set(key: BuildingId, value: Building): this {
    if (!this.held.has(key) && this.spilled(key)) {
      this.over.set(key, value);
      this.recent.delete(key);
    } else {
      this.held.set(key, value);
    }
    return this;
  }

  delete(key: BuildingId): boolean {
    if (this.held.delete(key)) return true;
    if (!this.spilled(key)) return false;
    this.gone.add(key);
    this.over.delete(key);
    this.recent.delete(key);
    this.spilledLive--;
    return true;
  }

  clear(): void {
    for (const key of this.rowOf.keys()) this.gone.add(key);
    this.spilledLive = 0;
    this.held.clear();
    this.over.clear();
    this.recent.clear();
  }

  *keys(): MapIterator<BuildingId> {
    for (let row = 0; row < this.table.rows; row++) {
      const key = this.table.idAt(row) as BuildingId;
      if (this.rowOf.get(key) === row && !this.gone.has(key)) yield key;
    }
    yield* this.held.keys();
  }

  *entries(): MapIterator<[BuildingId, Building]> {
    for (const key of this.keys()) yield [key, this.get(key)!];
  }

  *values(): MapIterator<Building> {
    for (const key of this.keys()) yield this.get(key)!;
  }

  [Symbol.iterator](): MapIterator<[BuildingId, Building]> {
    return this.entries();
  }

  forEach(visit: (value: Building, key: BuildingId, map: Map<BuildingId, Building>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}
