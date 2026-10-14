import type { RoadDoc } from '@world/doc';
import type { ChangeRect } from '@world/changes';
import type { Building, BuildingId } from '@world/buildings/types';

/**
 * THE BUILDINGS A READER KEEPS, IN THE STORE'S ORDER, FROM THE DIARY.
 *
 * A product that keeps some of the town's buildings (the lots with bays, the
 * yards with docks) needs them in the order of `BuildingStore.all()`: the
 * bays' ids and the lorries' draws follow it. Each such product walked every
 * building of the town whenever any one changed, and the town's ageing
 * changes a record every few seconds. Here the diary (`world/changes.ts`,
 * kind `buildings`) says which buildings changed; only those are looked at,
 * and the order is kept by rank (Nystrom, Game Programming Patterns, "Dirty
 * Flag" and "Spatial Partition": the change says what to redo).
 *
 * The rank of a building is its place in the store's `Map`: a building added
 * or put back after being taken away goes last, a record replaced keeps its
 * place (`BuildingStore.add`, `put`, `restore`, `remove`). A change whose
 * effect on the order is not known (a load, a store taken over, an edited
 * copy put in, an entry the diary forgot) reads the order from the store
 * again, whole.
 */

/** The store's order as ranks, kept from the diary. */
class StoreOrder {
  private serial = -1;
  /** The document followed: another one is read whole. */
  private doc: RoadDoc | null = null;
  private readonly ranks = new Map<BuildingId, number>();
  private next = 0;
  /** Moves each time the order is read whole: ranks of before and after are not comparable. */
  epoch = 0;

  rank(id: BuildingId): number | undefined {
    return this.ranks.get(id);
  }

  /** Brought up to the diary's latest entry. */
  follow(doc: RoadDoc): void {
    const journal = doc.changes;
    if (this.doc === doc && journal.serialOf('buildings') <= this.serial) { this.serial = journal.version; return; }
    const entries = this.doc === doc ? journal.since(this.serial, ['buildings']) : null;
    this.doc = doc;
    this.serial = journal.version;
    if (entries && entries.every((entry) => this.apply(entry.detail, entry.ids as readonly BuildingId[] | undefined))) return;
    this.reread(doc);
  }

  /** One entry of the diary applied to the ranks; false when its effect on the order is not known. */
  private apply(detail: string | undefined, ids: readonly BuildingId[] | undefined): boolean {
    if (!ids) return false;
    switch (detail) {
      case 'added':
        for (const id of ids) {
          if (this.ranks.has(id)) return false;
          this.ranks.set(id, this.next++);
        }
        return true;
      case 'replaced':
        // `put`: where it stood and where it stands, the same id twice; it keeps its place.
        return ids.every((id) => this.ranks.has(id));
      case 'removed':
        for (const id of ids) this.ranks.delete(id);
        return true;
      case 'restored':
        // `restore` over a record that stood: the same id twice, it keeps its place.
        if (ids.length === 2 && ids[0] === ids[1]) return this.ranks.has(ids[0]!);
        if (ids.length !== 1) return false;
        // One id: taken away if it stood, else put back, last.
        if (this.ranks.has(ids[0]!)) this.ranks.delete(ids[0]!);
        else this.ranks.set(ids[0]!, this.next++);
        return true;
      default:
        return false;
    }
  }

  /** @rebuild The order read whole: at the first look, or when the diary cannot say. */
  private reread(doc: RoadDoc): void {
    this.ranks.clear();
    this.next = 0;
    for (const b of doc.buildings.all()) this.ranks.set(b.id, this.next++);
    this.epoch++;
  }
}

/** What changed among the buildings since a reader last looked. */
export interface BuildingDelta {
  /** The ids the diary names, each once. */
  readonly ids: readonly BuildingId[];
  /** Where they stood and stand. */
  readonly rects: readonly ChangeRect[];
}

const NOTHING: BuildingDelta = { ids: [], rects: [] };

/**
 * The buildings that pass `keep`, in the store's order, kept from the diary.
 * `update` brings them up to date and says what changed since the last call.
 */
export class BuildingsInOrder {
  /** The store's order, this reader's own (it follows the diary with it). */
  private readonly order = new StoreOrder();
  private doc: RoadDoc | null = null;
  private serial = -1;
  /** Each kept building and the rank it was filed in the list at. */
  private readonly filedAt = new Map<BuildingId, number>();
  private list: BuildingId[] = [];
  private epoch = -1;

  constructor(private readonly keep: (b: Building) => boolean) {}

  /** The kept buildings' ids, in the store's order. */
  get ids(): readonly BuildingId[] {
    return this.list;
  }

  has(id: BuildingId): boolean {
    return this.filedAt.has(id);
  }

  /** A building's place in the store's order as of the last `update` (to sort other buildings by it). */
  rank(id: BuildingId): number {
    return this.order.rank(id) ?? Infinity;
  }

  /**
   * Up to date with the store. Returns the ids and rectangles the diary named
   * since the last call (nothing: none), or null when the store was read whole
   * (the first call, or the diary could not say what changed).
   */
  update(doc: RoadDoc): BuildingDelta | null {
    const order = this.order;
    order.follow(doc);
    const journal = doc.changes;
    if (this.doc === doc && journal.serialOf('buildings') <= this.serial && order.epoch === this.epoch) {
      this.serial = journal.version;
      return NOTHING;
    }
    const entries = this.doc === doc ? journal.since(this.serial, ['buildings']) : null;
    this.doc = doc;
    this.serial = journal.version;
    const ids = new Set<BuildingId>();
    const rects: ChangeRect[] = [];
    let known = entries !== null;
    for (const entry of entries ?? []) {
      if (!entry.rects || !entry.ids) { known = false; break; }
      rects.push(...entry.rects);
      for (const id of entry.ids) ids.add(id as BuildingId);
    }
    if (!known) {
      this.reread(doc);
      this.epoch = order.epoch;
      return null;
    }
    // Each building named: out, and back in at its rank if it is kept (a
    // building taken away and put back since stands last now). Found in the
    // list by the rank it was filed at, by halving: DO NOT walk the list.
    for (const id of ids) this.unfile(id);
    if (order.epoch !== this.epoch) this.resort();
    for (const id of ids) {
      const b = doc.buildings.get(id);
      if (b && this.keep(b)) this.file(id, order.rank(id)!);
    }
    return { ids: [...ids], rects };
  }

  /** Where a rank stands, or would stand, in the list (the list is in the order of the ranks it was filed at). */
  private slot(rank: number): number {
    let lo = 0, hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.filedAt.get(this.list[mid]!)! < rank) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  private file(id: BuildingId, rank: number): void {
    this.list.splice(this.slot(rank), 0, id);
    this.filedAt.set(id, rank);
  }

  private unfile(id: BuildingId): void {
    const rank = this.filedAt.get(id);
    if (rank === undefined) return;
    this.list.splice(this.slot(rank), 1);
    this.filedAt.delete(id);
  }

  /** @rebuild The kept buildings in the store's order read again whole: its ranks were (`StoreOrder.reread`). */
  private resort(): void {
    const order = this.order;
    this.list.sort((a, b) => order.rank(a)! - order.rank(b)!);
    for (const id of this.list) this.filedAt.set(id, order.rank(id)!);
    this.epoch = order.epoch;
  }

  /** @rebuild The kept buildings read whole from the store. */
  private reread(doc: RoadDoc): void {
    this.filedAt.clear();
    this.list = [];
    for (const b of doc.buildings.all()) {
      if (!this.keep(b)) continue;
      this.filedAt.set(b.id, this.order.rank(b.id)!);
      this.list.push(b.id);
    }
  }
}
