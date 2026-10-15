import { IdAllocator } from '../ids';
import { ChangeJournal, type ChangeRect } from '../changes';
import { JournalCursor } from '../derived';
import { samePlain } from '@core/plain';
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

/**
 * Where a building stands, for the diary: its box, or - a record with no
 * volume to measure - its anchor. DO NOT answer null for it: one such record
 * made the whole entry (every building of an edit) the whole map.
 */
function rectOf(b: Building): ChangeRect {
  const box = storedBounds(b);
  return Number.isFinite(box.minX) ? [box.minX, box.minY, box.maxX, box.maxY] : [b.x, b.y, b.x, b.y];
}

/**
 * The document's buildings, with their own revision.
 *
 * `revision` is deliberately NOT the document's: a building edit must not
 * rebuild the road network, the lanelets or the simulation, which is what
 * moving `RoadDoc.revision` does. The renderer gates the buildings layer on
 * this number (and on the terrain, which the foundations stand on).
 *
 * Every change is written in the document's diary (`changes.ts`, kind
 * `buildings`) with where the building stands, and `revision` is the serial
 * of the latest one: a building cannot change without the diary knowing.
 *
 * OWNERSHIP. A record handed to `add`, `put`, `restore` or `replaceWith`
 * becomes the store's: it is kept, not copied - only made the plain JSON
 * data a copy would have been, in place (`settleBuilding`: -0 is 0, no
 * `undefined` member) - and from then on NOBODY changes it or any object
 * inside it, the caller included. A change is a new record
 * (`cloneBuilding` the stored one, edit the draft, `put` the draft, as
 * `editor/buildings.ts` `editBuilding` does). Records may share parts with
 * each other (`put({ ...stored, decay })` keeps the stored volumes): they are
 * values, read-only once stored. The rest of the game counts on this: the
 * undo image keeps records by reference (`docImage.ts`), a cloned document
 * shares them (`shareFrom`), and each record's text, its bays' text
 * (`sim/agents/parking.ts`) and its walls are worked out once per record.
 *
 * DO NOT copy a record on the way in again "to be safe": the deep copy of
 * every record added or replaced (`cloneBuilding`, a JSON round trip) was
 * the largest cost of growing a generated city (2.2 s of a 2.5 km one), for
 * records their callers had just built and never touched again. A caller
 * that keeps editing what it handed over copies it itself.
 */
export class BuildingStore {
  /** @mapWide Every building of the map. */
  private readonly items = new Map<BuildingId, Building>();
  private ids = new IdAllocator(1);
  /**
   * The records made plain JSON data when they were adopted (`settleBuilding`,
   * OWNERSHIP above): one handed back - an undo, a clone's records - is not
   * walked again. Shared with the stores that share the records (`shareFrom`).
   */
  private settled = new WeakSet<object>();
  /** The buildings by place (`near`), kept by the writers below; null after a whole-store change, made again when asked. */
  private grid: BuildingGrid<Building> | null = null;

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

  /**
   * The ids of the buildings changed after `serial` (a `revision` read
   * before), from the diary; null when it cannot say which (a whole-store
   * change: loaded, cleared, shared; or entries forgotten): then read them
   * all. What a product derived from some buildings asks to take in a change
   * by its ids, never the whole store again (root CLAUDE.md, "Como adicionar
   * um produto derivado").
   */
  changedSince(serial: number): BuildingId[] | null {
    const entries = this.journal.since(serial, ['buildings']);
    if (!entries || entries.some((e) => !e.ids)) return null;
    return entries.flatMap((e) => e.ids!) as BuildingId[];
  }

  /** A reader's place in the buildings' diary, for `changedFor`. */
  static cursor(): JournalCursor {
    return new JournalCursor(['buildings'], true);
  }

  /**
   * The ids of the buildings changed since `cursor` last read this store
   * (`BuildingStore.cursor()`); null: read them all - the first read, another
   * store (a map opened), entries forgotten or without ids. What a product kept
   * from the buildings reads instead of holding a serial of its own: a serial
   * read against another document's diary answers "nothing changed" in silence
   * (`derived.ts` `JournalCursor`).
   */
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

  /**
   * The buildings whose box (or anchor) may reach the rectangle, in the order
   * of `all()`: a superset, the caller keeps its exact test (`grid.ts`). What
   * asks about one place asks this, never `all()`.
   */
  near(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    this.grid ??= new BuildingGrid(this.items.values(), (b) => storedBounds(b));
    return this.grid.near(minX, minY, maxX, maxY).map((id) => this.items.get(id)!);
  }

  /**
   * The buildings `meets` keeps for one of `rects`, asked of those within `pad` of it, each once, in the
   * store's order (`BuildingGrid.nearAny`): what `near` of each rectangle grown by `pad`, tested and joined,
   * gives - each cell read once.
   */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: Building, rect: readonly [number, number, number, number]) => boolean): Building[] {
    this.grid ??= new BuildingGrid(this.items.values());
    return this.grid.nearAny(rects, pad, (id, rect) => meets(this.items.get(id)!, rect)).map((id) => this.items.get(id)!);
  }

  /** The id the next `add` will hand out. */
  get nextId(): BuildingId {
    return asBuildingId(this.ids.peek);
  }

  /**
   * Stores a new building under a fresh id. The record becomes the store's
   * (see OWNERSHIP above): the stored one is it with the id set, its parts
   * not copied.
   * @perItem Runs once a building added: nothing it reaches may walk the map.
   */
  add(value: Omit<Building, 'id'>): Building {
    const id = asBuildingId(this.ids.take());
    const building = settleBuilding({ ...value, id } as Building, this.settled);
    this.items.set(id, building);
    this.grid?.insert(building);
    this.changed([building], 'added');
    return building;
  }

  /**
   * Replaces an existing building's record (same id). The record becomes the store's (OWNERSHIP above).
   * @perItem Runs once a building replaced: nothing it reaches may walk the map.
   */
  put(building: Building): void {
    const was = this.items.get(building.id);
    if (!was) return;
    const now = settleBuilding(building, this.settled, was);
    this.items.set(building.id, now);
    this.grid?.update(now);
    // Where it stood and where it stands: a moved building changes both.
    this.changed([was, now], 'replaced');
  }

  /**
   * Sets a building's wear (`Building.decay`), its volumes, place and use
   * kept. Written in the diary as `buildingWear`, so `revision` does not move.
   * DO NOT write a wear change with `put`: the town decays a tenth at a time,
   * every few seconds somewhere, and as a `buildings` change each tenth made
   * everything derived from the buildings' shape (walls, bays, yards, places,
   * grading, the camera's solids) work the town out again.
   * @perItem Runs once a building's wear moved: nothing it reaches may walk the map.
   */
  wear(id: BuildingId, decay: number): void {
    const was = this.items.get(id);
    if (!was || (was.decay ?? 0) === decay) return;
    const now = settleBuilding({ ...was, decay }, this.settled, was);
    this.items.set(id, now);
    this.grid?.update(now);
    this.journal.record('buildingWear', [rectOf(now)], { ids: [id as number] });
  }

  /**
   * Puts back a building as it was, or takes it away (`undefined`): undo and
   * redo (`world/docImage.ts`). The record is kept, not copied (a record the
   * undo image holds is a stored one, read-only: OWNERSHIP above); the diary
   * is told where it stood and where it stands.
   */
  restore(id: BuildingId, value: Building | undefined): void {
    const was = this.items.get(id);
    if (value === undefined) {
      if (!was) return;
      this.items.delete(id);
      this.grid?.delete(id);
      this.changed([was], 'restored');
      return;
    }
    const now = settleBuilding(value, this.settled, was);
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
    this.items.delete(id);
    this.grid?.delete(id);
    this.changed([was], 'removed');
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.grid = null;
    this.changed(null, 'cleared');
  }

  toJSON(): SerializedBuilding[] {
    return [...this.items.values()].map((b) => cloneBuilding(b));
  }

  /**
   * `JSON.stringify(this.toJSON())`, without the copies: a stored record is
   * plain and never changed in place (OWNERSHIP above), so its own text is
   * its copy's. Written when asked (the autosave, an export), never kept:
   * DO NOT keep each record's text beside it - a string the size of the
   * record held for every building of the town.
   */
  toText(): string {
    const parts: string[] = [];
    for (const b of this.items.values()) parts.push(JSON.stringify(b));
    return `[${parts.join(',')}]`;
  }

  /** Loads stored buildings, repairing or dropping what cannot be read. */
  load(data: readonly unknown[] | undefined): void {
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

  /**
   * The same records as another store (they are never changed in place):
   * `RoadDoc.clone`, whose diary then goes on from the source's
   * (`ChangeJournal.continueFrom`), so the copy is at the same revision.
   */
  shareFrom(source: BuildingStore): void {
    this.items.clear();
    this.grid = null;
    for (const [id, b] of source.items) this.items.set(id, b);
    // The same records, known plain to both (`settleBuilding`).
    this.settled = source.settled;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.changed(null, 'shared');
  }

  /** Keeps id allocation monotonic across a clone (see `RoadDoc.clone`). */
  copyAllocator(from: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, from.ids.peek));
  }

  /**
   * Replaces the contents from another store, writing a change only when
   * the buildings actually differ, and only of those that do (where they
   * stood and where they stand). Drawing a road replaces the whole document
   * with an edited clone; that must not rebuild every building.
   *
   * `changed`: the ids the source changed since it shared this store's
   * records (`RoadDoc.clone`, read from the copy's diary by
   * `RoadDoc.buildingsMovedIn`); only those are read. Null: any source (a map
   * loaded, an undo through JSON), every id compared, record by record.
   *
   * Only the records that differ are taken, each through the grid's own
   * writers (`insert`, `update`, `delete`), so the grid stays (a record kept
   * keeps its place in the order, a new one goes last, as `restore` does).
   * DO NOT go back to clearing the store and the grid and writing every
   * record again, nor to comparing the whole store as text (`toText` twice):
   * that was the whole town, twice over, on every road drawn.
   */
  replaceWith(source: BuildingStore, changed: readonly BuildingId[] | null = null): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    const touched: Building[] = [];
    /** Records that differ in their wear alone (`wear`): written as `buildingWear`, never as a change of shape. */
    const worn: Building[] = [];
    const take = (id: BuildingId): void => {
      const was = this.items.get(id);
      const now = source.items.get(id);
      if (was === now) return;
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
