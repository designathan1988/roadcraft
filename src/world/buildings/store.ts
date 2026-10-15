import { IdAllocator } from '../ids';
import { ChangeJournal, type ChangeRect } from '../changes';
import { JournalCursor } from '../derived';
import { samePlain } from '@core/plain';
import { ForkMap } from '@core/forkMap';
import { storedBounds } from './geometry';
import { BuildingGrid } from './grid';
import { migrateBuilding, type SerializedBuilding } from './serialize';
import { type Building, type BuildingId, asBuildingId, cloneBuilding, settleBuilding } from './types';

/** Two records the same in every field but their wear (`decay`), compared field by field, no copy and no text. */
function sameButWear(a: Building, b: Building): boolean {
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  for (const k in x) if (k !== 'decay' && !samePlain(x[k], y[k])) return false;
  for (const k in y) if (k !== 'decay' && x[k] === undefined && y[k] !== undefined) return false;
  return true;
}

/** DO NOT answer null for it: one such record made the whole entry (every building of an edit) the whole map. */
function rectOf(b: Building): ChangeRect {
  const box = storedBounds(b);
  return Number.isFinite(box.minX) ? [box.minX, box.minY, box.maxX, box.maxY] : [b.x, b.y, b.x, b.y];
}

/** DO NOT copy a record on the way in again "to be safe": the deep copy of every record added or replaced */
export class BuildingStore {
  /** @mapWide Every building of the map. A working copy's lies over the original's (`forkFrom`). */
  private items: Map<BuildingId, Building> = new Map();
  /** The store a working copy lies over (`forkFrom`) while it has written nothing: its questions by place are that store's. */
  private below: BuildingStore | null = null;
  private ids = new IdAllocator(1);
  /** The records made plain JSON data when they were adopted (`settleBuilding`, OWNERSHIP above): one handed back */
  private settled = new WeakSet<object>();
  /** The buildings by place (`near`), kept by the writers below; null after a whole-store change, made again when asked. */
  private grid: BuildingGrid | null = null;

  /** `journal`: the document's diary; a store on its own keeps one of its own. */
  constructor(private readonly journal: ChangeJournal = new ChangeJournal()) {}

  /** The serial of the latest change of the buildings in the diary (their shape, place or use; not their wear). */
  get revision(): number {
    return this.journal.serialOf('buildings');
  }

  /** The serial of the latest change of a building's wear (`wear`): what draws or saves a building reads it too. */
  get wearRevision(): number {
    return this.journal.serialOf('buildingWear');
  }

  /** Writes a change of these buildings (their rectangles, or the whole map when any has none). */
  private changed(buildings: readonly Building[] | null, detail?: string): void {
    const rects = buildings?.map(rectOf) ?? null;
    const ids = buildings?.map((b) => b.id as number);
    this.journal.record('buildings', rects, { ...(ids ? { ids } : {}), ...(detail ? { detail } : {}) });
  }

  /** The ids of the buildings changed after `serial` (a `revision` read before), from the diary */
  changedSince(serial: number): BuildingId[] | null {
    const entries = this.journal.since(serial, ['buildings']);
    if (!entries || entries.some((e) => !e.ids)) return null;
    return entries.flatMap((e) => e.ids!) as BuildingId[];
  }

  /** A reader's place in the buildings' diary, for `changedFor`. */
  static cursor(): JournalCursor {
    return new JournalCursor(['buildings'], true);
  }

  /** The ids of the buildings changed since `cursor` last read this store (`BuildingStore.cursor()`); null: read them all */
  changedFor(cursor: JournalCursor): BuildingId[] | null {
    const entries = cursor.read(this.journal);
    return entries === null ? null : entries.flatMap((e) => e.ids!) as BuildingId[];
  }

  get size(): number {
    return this.items.size;
  }

  get(id: BuildingId): Building | undefined {
    return this.items.get(id);
  }

  has(id: BuildingId): boolean {
    return this.items.has(id);
  }

  all(): IterableIterator<Building> {
    return this.items.values();
  }

  /** The buildings whose box (or anchor) may reach the rectangle, in the order of `all()` */
  near(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    if (this.below) return this.below.near(minX, minY, maxX, maxY);
    this.grid ??= new BuildingGrid(this.items.values());
    return this.grid.near(minX, minY, maxX, maxY).map((id) => this.items.get(id)!);
  }

  /** The buildings `meets` keeps for one of `rects`, asked of those within `pad` of it, each once, in the store's order */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: Building, rect: readonly [number, number, number, number]) => boolean): Building[] {
    if (this.below) return this.below.nearAny(rects, pad, meets);
    this.grid ??= new BuildingGrid(this.items.values());
    return this.grid.nearAny(rects, pad, (id, rect) => meets(this.items.get(id)!, rect)).map((id) => this.items.get(id)!);
  }

  /** The id the next `add` will hand out. */
  get nextId(): BuildingId {
    return asBuildingId(this.ids.peek);
  }

  /** @perItem Stores a new building under a fresh id. */
  add(value: Omit<Building, 'id'>): Building {
    const id = asBuildingId(this.ids.take());
    const building = settleBuilding({ ...value, id } as Building, this.settled);
    this.leaveBelow();
    this.items.set(id, building);
    this.grid?.insert(building);
    this.changed([building], 'added');
    return building;
  }

  /** @perItem Replaces an existing building's record (same id). */
  put(building: Building): void {
    const was = this.items.get(building.id);
    if (!was) return;
    const now = settleBuilding(building, this.settled, was);
    this.leaveBelow();
    this.items.set(building.id, now);
    this.grid?.update(now);
    // Where it stood and where it stands: a moved building changes both.
    this.changed([was, now], 'replaced');
  }

  /** @perItem DO NOT write a wear change with `put` */
  wear(id: BuildingId, decay: number): void {
    const was = this.items.get(id);
    if (!was || (was.decay ?? 0) === decay) return;
    const now = settleBuilding({ ...was, decay }, this.settled, was);
    this.leaveBelow();
    this.items.set(id, now);
    this.grid?.update(now);
    this.journal.record('buildingWear', [rectOf(now)], { ids: [id as number] });
  }

  /** Puts back a building as it was, or takes it away (`undefined`): undo and redo (`world/docImage.ts`). */
  restore(id: BuildingId, value: Building | undefined): void {
    const was = this.items.get(id);
    if (value === undefined) {
      if (!was) return;
      this.leaveBelow();
      this.items.delete(id);
      this.grid?.delete(id);
      this.changed([was], 'restored');
      return;
    }
    const now = settleBuilding(value, this.settled, was);
    this.leaveBelow();
    this.items.set(id, now);
    // A record put back where one stood keeps its place in the order; a new one goes last, as in `items`.
    if (was) this.grid?.update(now); else this.grid?.insert(now);
    this.ids.reserve(id);
    this.changed(was ? [was, now] : [now], 'restored');
  }

  /** The id the allocator hands out next, set back by undo. */
  restoreNextId(next: number): void {
    this.ids = new IdAllocator(next);
  }

  /** @perItem Runs once a building removed: nothing it reaches may walk the map. */
  remove(id: BuildingId): boolean {
    const was = this.items.get(id);
    if (!was) return false;
    this.leaveBelow();
    this.items.delete(id);
    this.grid?.delete(id);
    this.changed([was], 'removed');
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    this.changed(null, 'cleared');
  }

  toJSON(): SerializedBuilding[] {
    return [...this.items.values()].map((b) => cloneBuilding(b));
  }

  /** Written when asked (the autosave, an export), never kept: DO NOT keep each record's text beside it */
  toText(): string {
    const parts: string[] = [];
    for (const b of this.items.values()) parts.push(JSON.stringify(b));
    return `[${parts.join(',')}]`;
  }

  /** Loads stored buildings, repairing or dropping what cannot be read. */
  load(data: readonly unknown[] | undefined): void {
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    for (const raw of data ?? []) {
      const building = migrateBuilding(raw);
      if (!building || this.items.has(building.id)) continue;
      this.items.set(building.id, building);
      this.ids.reserve(building.id);
    }
    this.changed(null, 'loaded');
  }

  /** The same records as another store (they are never changed in place) */
  shareFrom(source: BuildingStore): void {
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    for (const [id, b] of source.items) this.items.set(id, b);
    // The same records, known plain to both (`settleBuilding`).
    this.settled = source.settled;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.changed(null, 'shared');
  }

  /** A working copy over another store (`RoadDoc.fork`): its records read through, each written here only */
  forkFrom(source: BuildingStore): void {
    this.items = new ForkMap(source.items);
    this.below = source;
    this.grid = null;
    this.settled = source.settled;
    this.ids = new IdAllocator(source.ids.peek);
  }

  /** Takes back a working copy over this store (`forkFrom`): the records it deleted, replaced */
  takeFork(copy: BuildingStore): void {
    const { gone, replaced, added } = (copy.items as ForkMap<BuildingId, Building>).changes();
    for (const id of gone) { this.items.delete(id); this.grid?.delete(id); }
    for (const [id, b] of replaced) { this.items.set(id, b); this.grid?.update(b); }
    for (const [id, b] of added) { this.items.set(id, b); this.grid?.insert(b); }
    this.ids = new IdAllocator(copy.ids.peek);
  }

  /** A working copy about to write: its questions by place its own from now on (the grid made when first asked). */
  private leaveBelow(): void {
    if (!this.below) return;
    this.below = null;
    this.grid = null;
  }

  /** Keeps id allocation monotonic across a clone (see `RoadDoc.clone`). */
  copyAllocator(from: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, from.ids.peek));
  }

  /** DO NOT go back to clearing the store and the grid and writing every record again */
  replaceWith(source: BuildingStore, changed: readonly BuildingId[] | null = null): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    const touched: Building[] = [];
    /** Records that differ in their wear alone (`wear`): written as `buildingWear`, never as a change of shape. */
    const worn: Building[] = [];
    const take = (id: BuildingId): void => {
      const was = this.items.get(id);
      const now = source.items.get(id);
      if (was === now) return;
      this.leaveBelow();
      if (!now) {
        this.items.delete(id);
        this.grid?.delete(id);
        touched.push(was!);
        return;
      }
      // The source's record itself, as `shareFrom` does: read-only once stored (OWNERSHIP above).
      const kept = settleBuilding(now, this.settled);
      this.items.set(id, kept);
      if (!was) {
        this.grid?.insert(kept);
        touched.push(kept);
      } else if (!samePlain(kept, was)) {
        this.grid?.update(kept);
        if ((kept.decay ?? 0) !== (was.decay ?? 0) && sameButWear(kept, was)) worn.push(kept);
        else touched.push(was, kept);
      }
    };
    if (changed) {
      for (const id of new Set(changed)) take(id);
    } else {
      // Deleting the entry being visited is safe: a Map iteration skips only entries deleted before their visit (MDN, Map.prototype.forEach).
      for (const id of this.items.keys()) if (!source.items.has(id)) take(id);
      for (const id of source.items.keys()) take(id);
    }
    if (touched.length) this.changed(touched, 'replaced by an edit or an undo');
    if (worn.length) this.journal.record('buildingWear', worn.map(rectOf), { ids: worn.map((w) => w.id as number) });
  }
}
