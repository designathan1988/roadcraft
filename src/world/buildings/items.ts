import type { TableRows } from './tableRows';
import type { Building, BuildingId } from './types';

/** THE STORE'S BUILDINGS: A RECORD TABLE (`TableRows`, decoded when read) WITH THE RECORDS WRITTEN SINCE OVER IT. A `Map` to its readers, in a `Map`'s order (a key set again keeps its place, one deleted and set again goes last); its writes told before they happen while an edit is recorded (`before`, as `core/recordMap.ts`). */
export class BuildingItems implements Map<BuildingId, Building> {
  /** Ids of the table given another record; still at their row's place. */
  private replaced = new Map<BuildingId, Building>();
  /** Ids after the table's: new ones, and the table's deleted and set again. */
  private added = new Map<BuildingId, Building>();
  /** Ids of the table deleted (those set again are in `added` too). */
  private gone = new Set<BuildingId>();
  /** Told a key's value before it is written (undefined: the key was not there); null: nobody listens. */
  before: ((key: BuildingId, was: Building | undefined) => void) | null = null;

  constructor(private base: TableRows | null = null) {}

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  /** The table under the records written (null: none, every record written here). */
  get table(): TableRows | null {
    return this.base;
  }

  /** A copy that reads the same table and holds the same records written (`BuildingStore.shareFrom`): its cost the records written, never the table. */
  copy(): BuildingItems {
    const out = new BuildingItems(this.base);
    out.replaced = new Map(this.replaced);
    out.added = new Map(this.added);
    out.gone = new Set(this.gone);
    return out;
  }

  /** What was written over the table, in the order `BuildingItems.over` puts it back (the save's sections, the simulation's map). */
  writes(): { readonly gone: ReadonlySet<BuildingId>; readonly replaced: ReadonlyMap<BuildingId, Building>; readonly added: ReadonlyMap<BuildingId, Building> } {
    return { gone: this.gone, replaced: this.replaced, added: this.added };
  }

  /** The items of a table and what was written over it (`writes`), as they were. */
  static over(base: TableRows | null, gone: Iterable<BuildingId>, replaced: Iterable<Building>, added: Iterable<Building>): BuildingItems {
    const out = new BuildingItems(base);
    for (const id of gone) out.gone.add(id);
    for (const b of replaced) out.replaced.set(b.id, b);
    for (const b of added) out.added.set(b.id, b);
    return out;
  }

  /** Whether the record of `key` was written here (not the table's own). */
  owns(key: BuildingId): boolean {
    return this.added.has(key) || this.replaced.has(key);
  }

  /** Whether `key` reads the very same record here and in `other`, known without decoding it: both over one table, neither wrote it. */
  sameUnwritten(other: BuildingItems, key: BuildingId): boolean {
    return this.base !== null && this.base === other.base && !this.owns(key) && !other.owns(key)
      && !this.gone.has(key) && !other.gone.has(key) && this.base.has(key);
  }

  get size(): number {
    return (this.base?.size ?? 0) - this.gone.size + this.added.size;
  }

  get(key: BuildingId): Building | undefined {
    const added = this.added.get(key);
    if (added !== undefined) return added;
    if (this.gone.has(key)) return undefined;
    return this.replaced.get(key) ?? this.base?.get(key);
  }

  has(key: BuildingId): boolean {
    return this.added.has(key) || (!this.gone.has(key) && (this.replaced.has(key) || (this.base?.has(key) ?? false)));
  }

  private inBase(key: BuildingId): boolean {
    return this.base?.has(key) ?? false;
  }

  set(key: BuildingId, value: Building): this {
    this.before?.(key, this.get(key));
    if (this.added.has(key) || this.gone.has(key) || !this.inBase(key)) this.added.set(key, value);
    else this.replaced.set(key, value);
    return this;
  }

  delete(key: BuildingId): boolean {
    if (!this.has(key)) return false;
    this.before?.(key, this.get(key));
    if (this.added.delete(key)) return true;
    this.replaced.delete(key);
    this.gone.add(key);
    return true;
  }

  /** Every record let go, the table with them. */
  clear(): void {
    if (this.before) for (const [key, value] of this.entries()) this.before(key, value);
    this.base = null;
    this.replaced.clear();
    this.added.clear();
    this.gone.clear();
  }

  /** DO NOT decode a record to list ids: the table's id column, then the ids written after it. */
  *keys(): MapIterator<BuildingId> {
    if (this.base) for (const key of this.base.keys()) if (!this.gone.has(key)) yield key;
    yield* this.added.keys();
  }

  *entries(): MapIterator<[BuildingId, Building]> {
    const base = this.base;
    if (base) {
      for (let row = 0; row < base.size; row++) {
        const key = base.idAt(row);
        if (this.gone.has(key)) continue;
        yield [key, this.replaced.get(key) ?? base.record(row)];
      }
    }
    yield* this.added.entries();
  }

  *values(): MapIterator<Building> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[BuildingId, Building]> {
    return this.entries();
  }

  forEach(visit: (value: Building, key: BuildingId, map: Map<BuildingId, Building>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}
