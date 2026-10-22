import { IdSlots, grown } from '@core/idSlots';
import type { RoadDoc } from '@world/doc';
import type { ChangeKind, ChangeRect, JournalReader } from '@world/changes';
import type { BuildingId } from '@world/buildings/types';
import { BATCH_DETAIL, BATCH_GONE, BATCH_KEPT, type BuildingSource, type TrafficFacts } from './trafficBuildings';

/** THE BUILDINGS A READER KEEPS, IN THE STORE'S ORDER, FROM THE DIARY. */

/** The store's order as ranks, kept from the diary. */
class StoreOrder {
  private serial = -1;
  /** The document followed: another one is read whole. */
  private doc: RoadDoc | null = null;
  /** Each building's rank in a column at its id's slot (`core/idSlots.ts`): DO NOT keep a `Map` entry a building of the city. */
  private readonly slots = new IdSlots(1024);
  private ranks = new Float64Array(16);
  private next = 0;
  /** Moves each time the order is read whole: ranks of before and after are not comparable. */
  epoch = 0;

  constructor() {
    this.slots.onGrow = (n) => { this.ranks = grown(this.ranks, n); };
  }

  rank(id: BuildingId): number | undefined {
    const slot = this.slots.get(id);
    return slot < 0 ? undefined : this.ranks[slot];
  }

  private has(id: BuildingId): boolean {
    return this.slots.get(id) >= 0;
  }

  private place(id: BuildingId): void {
    // The slot taken first: taking it may grow the column (`onGrow`).
    const slot = this.slots.take(id);
    this.ranks[slot] = this.next++;
  }

  /** Brought up to the diary's latest entry. */
  follow(w: BuildingSource): void {
    const doc = w.doc, journal = doc.changes;
    if (this.doc === doc && journal.serialOf('buildings') <= this.serial) { this.serial = journal.version; return; }
    const entries = this.doc === doc ? journal.since(this.serial, ['buildings']) : null;
    this.doc = doc;
    this.serial = journal.version;
    if (entries && entries.every((entry) => this.apply(entry.detail, entry.ids as readonly BuildingId[] | undefined))) return;
    this.reread(w);
  }

  /** One entry of the diary applied to the ranks; false when its effect on the order is not known. */
  private apply(detail: string | undefined, ids: readonly BuildingId[] | undefined): boolean {
    if (!ids) return false;
    // The worker's table's batch: a letter an id, in order (`TrafficBuildingTable.apply`).
    if (detail?.startsWith(BATCH_DETAIL)) {
      const ops = detail.slice(BATCH_DETAIL.length);
      if (ops.length !== ids.length) return false;
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k]!, op = ops[k];
        if (op === BATCH_KEPT) { if (!this.has(id)) return false; }
        else if (op === BATCH_GONE) this.slots.delete(id);
        else this.place(id);
      }
      return true;
    }
    switch (detail) {
      case 'added':
        for (const id of ids) {
          if (this.has(id)) return false;
          this.place(id);
        }
        return true;
      case 'replaced':
        // `put`: where it stood and where it stands, the same id twice; it keeps its place.
        return ids.every((id) => this.has(id));
      case 'removed':
        for (const id of ids) this.slots.delete(id);
        return true;
      case 'restored':
        // `restore` over a record that stood: the same id twice, it keeps its place.
        if (ids.length === 2 && ids[0] === ids[1]) return this.has(ids[0]!);
        if (ids.length !== 1) return false;
        // One id: taken away if it stood, else put back, last.
        if (this.has(ids[0]!)) this.slots.delete(ids[0]!);
        else this.place(ids[0]!);
        return true;
      default:
        return false;
    }
  }

  /** @rebuild The order read whole: at the first look, or when the diary cannot say. DO NOT decode every record for its id: the ids alone (`TrafficBuildings.ids`). */
  private reread(w: BuildingSource): void {
    this.slots.clear();
    this.next = 0;
    for (const id of w.buildings.ids()) this.place(id);
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
/** Past this many named in one update, the list is walked once and merged (`merge`), not spliced a building at a time. */
const MERGE_PAST = 32;

/** The buildings that pass `keep`, in the store's order, kept from the diary. */
export class BuildingsInOrder implements JournalReader {
  readonly kinds: readonly ChangeKind[] = ['buildings'];
  /** What it has read up to (`JournalReader`): its diary keeps the buildings' entries after it until it reads them. */
  get seenSerial(): number {
    return this.serial;
  }
  /** The store's order, this reader's own (it follows the diary with it). */
  private readonly order = new StoreOrder();
  private doc: RoadDoc | null = null;
  private serial = -1;
  /** Each kept building and the rank it was filed in the list at. */
  private readonly filedAt = new Map<BuildingId, number>();
  private list: BuildingId[] = [];
  private epoch = -1;

  /** `keep`: asked of a building's facts, never its traffic record (`TrafficBuildings.facts`: the worker works no record out for it). */
  constructor(private readonly keep: (b: TrafficFacts) => boolean) {}

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

  /** Up to date with the store. */
  update(w: BuildingSource): BuildingDelta | null {
    const order = this.order;
    order.follow(w);
    const doc = w.doc, journal = doc.changes;
    if (this.doc === doc && journal.serialOf('buildings') <= this.serial && order.epoch === this.epoch) {
      this.serial = journal.version;
      return NOTHING;
    }
    const entries = this.doc === doc ? journal.since(this.serial, ['buildings']) : null;
    if (this.doc !== doc) journal.follow(this);
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
      this.reread(w);
      this.epoch = order.epoch;
      return null;
    }
    // A few: found in the list by the rank it was filed at, by halving (DO NOT walk the list). Many (a tile's): DO NOT splice each in, the list walked once and the new ones merged in.
    if (ids.size > MERGE_PAST) this.merge(w, ids);
    else {
      for (const id of ids) this.unfile(id);
      if (order.epoch !== this.epoch) this.resort();
      for (const id of ids) {
        const b = w.buildings.facts(id);
        if (b && this.keep(b)) this.file(id, order.rank(id)!);
      }
    }
    return { ids: [...ids], rects };
  }

  /** The named buildings taken out of the list in one walk, those kept now filed back by one merge of the two orders. */
  private merge(w: BuildingSource, ids: ReadonlySet<BuildingId>): void {
    const order = this.order;
    for (const id of ids) this.filedAt.delete(id);
    let list = this.list.filter((id) => !ids.has(id));
    if (order.epoch !== this.epoch) {
      list.sort((a, b) => order.rank(a)! - order.rank(b)!);
      for (const id of list) this.filedAt.set(id, order.rank(id)!);
      this.epoch = order.epoch;
    }
    const come: BuildingId[] = [];
    for (const id of ids) {
      const b = w.buildings.facts(id);
      if (b && this.keep(b)) { come.push(id); this.filedAt.set(id, order.rank(id)!); }
    }
    if (come.length) {
      come.sort((a, b) => this.filedAt.get(a)! - this.filedAt.get(b)!);
      const out: BuildingId[] = new Array(list.length + come.length);
      let i = 0, j = 0, k = 0;
      while (i < list.length || j < come.length) {
        out[k++] = j >= come.length || (i < list.length && this.filedAt.get(list[i]!)! < this.filedAt.get(come[j]!)!) ? list[i++]! : come[j++]!;
      }
      list = out;
    }
    this.list = list;
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
  private reread(w: BuildingSource): void {
    this.filedAt.clear();
    this.list = [];
    w.buildings.eachFacts((b) => {
      if (!this.keep(b)) return;
      this.filedAt.set(b.id, this.order.rank(b.id)!);
      this.list.push(b.id);
    });
  }
}
