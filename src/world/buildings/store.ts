import { IdAllocator } from '../ids';
import { ChangeJournal, type ChangeRect } from '../changes';
import { storedBounds } from './geometry';
import { migrateBuilding, type SerializedBuilding } from './serialize';
import { type Building, type BuildingId, asBuildingId, cloneBuilding } from './types';

/** Each stored record's text (`BuildingStore.toText`). */
const RECORD_TEXT = new WeakMap<Building, string>();

/** Where a building stands, for the diary. */
function rectOf(b: Building): ChangeRect | null {
  const box = storedBounds(b);
  return Number.isFinite(box.minX) ? [box.minX, box.minY, box.maxX, box.maxY] : null;
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
 */
export class BuildingStore {
  private readonly items = new Map<BuildingId, Building>();
  private ids = new IdAllocator(1);

  /** `journal`: the document's diary; a store on its own keeps one of its own. */
  constructor(private readonly journal: ChangeJournal = new ChangeJournal()) {}

  /** The serial of the latest change of the buildings in the diary. */
  get revision(): number {
    return this.journal.serialOf('buildings');
  }

  /** Writes a change of these buildings (their rectangles, or the whole map when any has none). */
  private changed(buildings: readonly Building[] | null, detail?: string): void {
    const rects = buildings?.map(rectOf) ?? null;
    const known = rects && rects.every((r): r is ChangeRect => r !== null) ? rects : null;
    const ids = buildings?.map((b) => b.id as number);
    this.journal.record('buildings', known, { ...(ids ? { ids } : {}), ...(detail ? { detail } : {}) });
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

  /** The id the next `add` will hand out. */
  get nextId(): BuildingId {
    return asBuildingId(this.ids.peek);
  }

  /** Stores a new building under a fresh id. The record is copied. */
  add(value: Omit<Building, 'id'>): Building {
    const id = asBuildingId(this.ids.take());
    const building = { ...cloneBuilding(value as Building), id } as Building;
    this.items.set(id, building);
    this.changed([building], 'added');
    return building;
  }

  /** Replaces an existing building's record (same id). */
  put(building: Building): void {
    const was = this.items.get(building.id);
    if (!was) return;
    const now = cloneBuilding(building);
    this.items.set(building.id, now);
    // Where it stood and where it stands: a moved building changes both.
    this.changed([was, now], 'replaced');
  }

  remove(id: BuildingId): boolean {
    const was = this.items.get(id);
    if (!was) return false;
    this.items.delete(id);
    this.changed([was], 'removed');
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.changed(null, 'cleared');
  }

  toJSON(): SerializedBuilding[] {
    return [...this.items.values()].map((b) => cloneBuilding(b));
  }

  /**
   * `JSON.stringify(this.toJSON())`, each record's text written once: records
   * are never changed in place (`put` stores a copy), and writing every
   * furnished building again was most of the text the undo took on each road
   * drawn (docs/performance.md #21).
   */
  toText(): string {
    const parts: string[] = [];
    for (const b of this.items.values()) {
      let text = RECORD_TEXT.get(b);
      if (text === undefined) {
        text = JSON.stringify(cloneBuilding(b));
        RECORD_TEXT.set(b, text);
      }
      parts.push(text);
    }
    return `[${parts.join(',')}]`;
  }

  /** Loads stored buildings, repairing or dropping what cannot be read. */
  load(data: readonly unknown[] | undefined): void {
    this.items.clear();
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
    for (const [id, b] of source.items) this.items.set(id, b);
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
   */
  replaceWith(source: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    // The same records (a clone shares them, `shareFrom`): nothing to compare.
    if (this.items.size === source.items.size && [...source.items].every(([id, b]) => this.items.get(id) === b)) return;
    if (this.toText() === source.toText()) return;
    const touched: Building[] = [];
    for (const [id, was] of this.items) {
      const now = source.items.get(id);
      if (!now || (now !== was && this.textOf(now) !== this.textOf(was))) touched.push(was);
    }
    for (const [id, now] of source.items) {
      const was = this.items.get(id);
      if (!was || (now !== was && this.textOf(now) !== this.textOf(was))) touched.push(now);
    }
    this.items.clear();
    for (const b of source.items.values()) this.items.set(b.id, cloneBuilding(b));
    this.changed(touched, 'replaced by an edit or an undo');
  }

  /** One record's text, written once (`toText`). */
  private textOf(b: Building): string {
    let text = RECORD_TEXT.get(b);
    if (text === undefined) {
      text = JSON.stringify(cloneBuilding(b));
      RECORD_TEXT.set(b, text);
    }
    return text;
  }
}
