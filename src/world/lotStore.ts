import type { Vec2 } from '@core/vec2';
import { ChangeJournal, rectAround, type ChangeRect } from './changes';
import { CellFiling } from './cells';
import { JournalCursor } from './derived';
import { IdAllocator } from './ids';
import { insideLot, type Lot } from './lots';
import { m } from './units';

/** Where a lot lies: the box round its corners. */
export function lotBox(lot: Pick<Lot, 'corners'>): ChangeRect {
  return rectAround(lot.corners) ?? [0, 0, 0, 0];
}

/**
 * Side of the cells the lots are filed in, world units: a few lots wide (a lot
 * is some 22 x 32 m), so a question at a point (`at`, the lot under the
 * pointer) reads a handful of lots, not a city block's.
 */
const LOT_CELL = m(64);

/** One change of some lots as the store applies it (`LotStore.apply`). */
export interface LotEdit {
  /** Lots taken away, by id. */
  readonly remove?: readonly number[];
  /** Records replacing the stored ones of the same id, each in its place in the order. */
  readonly put?: readonly Lot[];
  /** New lots: each given the next id, last in the order. */
  readonly add?: readonly Omit<Lot, 'id'>[];
  /** Where else the change reached (a lot side curved past its corners): written with the lots' own boxes. */
  readonly also?: readonly ChangeRect[];
}

/**
 * THE DOCUMENT'S LOTS (`RoadDoc.lotStore`), with an owner: the records by id,
 * the lots by place (`in`, `at`), and every change written in the diary with
 * the ids it touched and where (kind `lots`), as `BuildingStore` keeps the
 * buildings. Before it the lots were a bare array on the document, written in
 * place by a dozen functions: a lot found by id was a search of the whole list
 * (`findIndex`), a lot taken out a shift of the whole list, the lot under the
 * pointer a test of every lot of the city, and the diary's entries carried no
 * ids, so whoever kept something per lot (the open lots, the undo image) took
 * any change for "everything changed" and read the city again.
 *
 * OWNERSHIP. A record handed to the store is the store's and is never changed
 * in place - by anyone, the caller included: a change is a new record (`put`),
 * as `BuildingStore`'s. The undo image keeps records by reference
 * (`docImage.ts`), a cloned document shares them (`shareFrom`), and the filing
 * by place knows a record by its identity (`CellFiling.file`).
 *
 * ORDER. The lots have an order (the growth draws "the k-th open lot",
 * `openLots.ts`; the file lists them in it): a record replaced keeps its
 * place, a new one - made, cut from another, or put back by an undo - goes
 * last (a `Map` iterates in the order keys were first inserted: MDN, `Map`).
 * Each record's place is a number (`orderOf`) that only grows, so a reader
 * kept by id tells a lot that went and came back (now last) from one changed
 * where it stands.
 *
 * DO NOT hand the lots out as an array the callers write into, nor search one
 * by id or by place: a lot is found by `get(id)`, `in(rect)` and `at(point)`.
 */
export class LotStore {
  /** @mapWide Every lot of the map, in the lots' order. */
  private items = new Map<number, Lot>();
  /** Each lot's place in the order: grows with every lot put last. */
  private order = new Map<number, number>();
  private nextOrder = 0;
  private ids = new IdAllocator(1);
  /** The lots by place, kept by the writers below; null after a whole-store change (a load, a copy), filed again when first asked. */
  private filing: CellFiling<number, Lot> | null = null;
  /** The land already cut into lots (`lots.ts` `planLots`), in the order it was cut, and the same as a set. */
  private keyList: string[] = [];
  private keySet = new Set<string>();
  /** The lots as an array, for the readers that still take one (`RoadDoc.lots`); null when a write made it stale. */
  private listed: readonly Lot[] | null = null;

  /** `journal`: the document's diary; a store on its own keeps one of its own. */
  constructor(private readonly journal: ChangeJournal = new ChangeJournal()) {}

  /** The serial of the latest change of the lots in the diary. */
  get revision(): number {
    return this.journal.serialOf('lots');
  }

  get size(): number {
    return this.items.size;
  }

  get(id: number): Lot | undefined {
    return this.items.get(id);
  }

  has(id: number): boolean {
    return this.items.has(id);
  }

  /** Every lot, in the lots' order: what saves, copies or makes the whole map again reads; nothing that asks about a place. */
  all(): IterableIterator<Lot> {
    return this.items.values();
  }

  /** A lot's place in the order (`ORDER` above): a lot put last gets a number greater than any before. */
  orderOf(id: number): number | undefined {
    return this.order.get(id);
  }

  /**
   * The lots as an array, in their order, made again only after a change: for
   * the readers that still take an array (`RoadDoc.lots`, pending their move
   * to `in`/`at`/`get`).
   * @rebuild The whole list only after a write.
   */
  list(): readonly Lot[] {
    return this.listed ??= [...this.items.values()];
  }

  /** The id the next new lot gets. */
  get nextId(): number {
    return this.ids.peek;
  }

  /** The id allocator set back (undo, `RoadDoc.restore`). */
  restoreNextId(next: number): void {
    this.ids = new IdAllocator(next);
  }

  /** The land already cut into lots, in the order it was cut. */
  get keys(): readonly string[] {
    return this.keyList;
  }

  hasKey(key: string): boolean {
    return this.keySet.has(key);
  }

  /**
   * The lots whose box meets `rect`, in increasing id order: a superset of
   * those whose shape reaches it (the caller keeps its exact test).
   */
  in(rect: ChangeRect): Lot[] {
    return this.cells().idsMeeting(rect).map((id) => this.items.get(id)!);
  }

  /** The lot whose shape holds `p` (the first in the lots' order when lots overlap), or undefined. */
  at(p: Vec2): Lot | undefined {
    let best: Lot | undefined, bestOrder = Infinity;
    for (const lot of this.in([p.x, p.y, p.x, p.y])) {
      const order = this.order.get(lot.id)!;
      if (order < bestOrder && insideLot(p, lot)) { best = lot; bestOrder = order; }
    }
    return best;
  }

  /**
   * The ids of the lots changed after `serial` (a `revision` read before),
   * from the diary; null when it cannot say which (a load, a copy taken
   * whole, entries forgotten): then read them all.
   */
  changedSince(serial: number): number[] | null {
    const entries = this.journal.since(serial, ['lots']);
    if (!entries || entries.some((e) => !e.ids)) return null;
    return entries.flatMap((e) => e.ids!);
  }

  /** A reader's place in the lots' diary (`changedFor`). */
  static cursor(): JournalCursor {
    return new JournalCursor(['lots'], true);
  }

  /**
   * The ids of the lots changed since `cursor` last read this store; null:
   * read them all (the first read, another store, entries forgotten or
   * without ids - a load, a copy taken whole).
   */
  changedFor(cursor: JournalCursor): number[] | null {
    const entries = cursor.read(this.journal);
    return entries === null ? null : entries.flatMap((e) => e.ids!);
  }

  /**
   * One change of the lots, written in the diary as ONE entry with every id it
   * touched and where they were and are. Returns the lots added, in order.
   */
  apply(edit: LotEdit, cause: string): Lot[] {
    const ids: number[] = [];
    const rects: ChangeRect[] = [...(edit.also ?? [])];
    for (const id of edit.remove ?? []) {
      const was = this.items.get(id);
      if (!was) continue;
      this.drop(id);
      ids.push(id);
      rects.push(lotBox(was));
    }
    for (const lot of edit.put ?? []) {
      const was = this.items.get(lot.id);
      if (!was) throw new Error(`LotStore: lot ${lot.id} put but not stored`);
      if (was === lot) continue;
      this.items.set(lot.id, lot);
      this.filing?.file(lot.id, lot, lotBox(lot));
      this.listed = null;
      ids.push(lot.id);
      rects.push(lotBox(was), lotBox(lot));
    }
    const added: Lot[] = [];
    for (const value of edit.add ?? []) {
      const lot = { ...value, id: this.ids.take() } as Lot;
      this.append(lot);
      added.push(lot);
      ids.push(lot.id);
      rects.push(lotBox(lot));
    }
    if (ids.length) this.journal.record('lots', rects, { ids, cause });
    return added;
  }

  /**
   * Adds land to what is already cut into lots (`lots.ts` `applyLots`): the
   * keys not known yet, written where their land lies (`rects[i]`; the whole
   * map for a key with none). Written as `lotKeys`, NOT as `lots`: no lot came
   * or went, and a reader of the lots by id takes an entry without ids for
   * "everything changed". Returns whether any key was new.
   */
  addKeys(keys: readonly string[], rects: readonly ChangeRect[] | undefined, cause: string): boolean {
    const where: ChangeRect[] = [];
    let placeless = false, added = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (this.keySet.has(key)) continue;
      this.keySet.add(key);
      this.keyList.push(key);
      added = true;
      const r = rects?.[i];
      if (r) where.push(r); else placeless = true;
    }
    if (added) this.journal.record('lotKeys', placeless ? null : where, { cause });
    return added;
  }

  /** A stretch of the keys put back as it was (undo, `RoadDoc.restore`): `list.splice`, the set kept with it. */
  spliceKeys(start: number, remove: number, items: readonly string[]): string[] {
    const tail = this.keyList.splice(start + remove);
    const gone = this.keyList.splice(start, remove);
    for (const key of gone) this.keySet.delete(key);
    for (const key of items) { this.keyList.push(key); this.keySet.add(key); }
    for (const key of tail) this.keyList.push(key);
    return gone;
  }

  /**
   * Puts lots back as they were, or takes them away (`undefined`): undo and
   * redo (`world/docImage.ts`), all in one entry. A lot put back where one of
   * its id stands keeps its place; one that was gone goes last.
   */
  restore(records: readonly { readonly id: number; readonly value: Lot | undefined }[], cause: string): void {
    const ids: number[] = [];
    const rects: ChangeRect[] = [];
    for (const { id, value } of records) {
      const was = this.items.get(id);
      if (!was && value === undefined) continue;
      if (was) rects.push(lotBox(was));
      if (value === undefined) this.drop(id);
      else if (was) {
        this.items.set(id, value);
        this.filing?.file(id, value, lotBox(value));
        this.listed = null;
      } else {
        this.append(value);
        this.ids.reserve(id);
      }
      if (value) rects.push(lotBox(value));
      ids.push(id);
    }
    if (ids.length) this.journal.record('lots', rects, { ids, cause });
  }

  /** The lots and keys of a map read (`RoadDoc.fromJSON`): the whole store, entries without ids. */
  load(lots: readonly Lot[], keys: readonly string[]): void {
    this.reset();
    for (const lot of lots) {
      this.append(lot);
      this.ids.reserve(lot.id);
    }
    for (const key of keys) if (!this.keySet.has(key)) { this.keySet.add(key); this.keyList.push(key); }
    if (lots.length) this.journal.record('lots', null, { cause: 'mapa carregado' });
    if (keys.length) this.journal.record('lotKeys', null, { cause: 'mapa carregado' });
  }

  /**
   * The same records as another store (they are never changed in place):
   * `RoadDoc.clone`, whose diary then goes on from the source's, so the copy
   * stands at the same revision. Each record keeps its place number, so a
   * change of the copy taken back (`replaceWith`) tells a lot put last from
   * one changed in place. The filing is made only if the copy is asked by place.
   */
  shareFrom(source: LotStore): void {
    this.items = new Map(source.items);
    this.order = new Map(source.order);
    this.nextOrder = source.nextOrder;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.keyList = [...source.keyList];
    this.keySet = new Set(source.keySet);
    this.filing = null;
    this.listed = null;
  }

  /**
   * Takes another store's lots, writing only those that differ.
   *
   * `changed`: the ids a working copy of this document changed since it was
   * copied (`RoadDoc.clone`, read from the copy's diary); only those are read,
   * and a lot the copy put last (cut, joined, put back) goes last here too, so
   * the order is the copy's. Null: any other source (a map loaded, the
   * document as it stood before a refused edit): the records compared by
   * identity (they are shared, never changed in place); when any differs the
   * source's order is taken whole and the diary told so (an entry without
   * ids). DO NOT compare the lots as text (`JSON.stringify` of the whole list):
   * it was the whole cadastre written out twice on every road drawn.
   */
  replaceWith(source: LotStore, changed: readonly number[] | null, cause: string): boolean {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    let keysMoved = false;
    if (source.keyList.length !== this.keyList.length || source.keyList.some((k, i) => k !== this.keyList[i])) {
      this.keyList = [...source.keyList];
      this.keySet = new Set(source.keySet);
      keysMoved = true;
      this.journal.record('lotKeys', null, { cause });
    }
    if (changed) {
      const ids: number[] = [];
      const rects: ChangeRect[] = [];
      const last: number[] = [];
      for (const id of new Set(changed)) {
        const was = this.items.get(id), now = source.items.get(id);
        if (!was && !now) continue;
        if (was && now && this.order.get(id) === source.order.get(id)) {
          // Changed where it stands: replaced in place (a `Map`'s `set` keeps the key's place).
          if (was === now) continue;
          this.items.set(id, now);
          this.filing?.file(id, now, lotBox(now));
          this.listed = null;
          rects.push(lotBox(was), lotBox(now));
          ids.push(id);
          continue;
        }
        if (was) { rects.push(lotBox(was)); this.drop(id); }
        if (now) { rects.push(lotBox(now)); last.push(id); }
        ids.push(id);
      }
      // In the copy's order: each with the copy's place number (kept, or given there when it went last).
      last.sort((a, b) => source.order.get(a)! - source.order.get(b)!);
      for (const id of last) this.append(source.items.get(id)!, source.order.get(id)!);
      this.nextOrder = Math.max(this.nextOrder, source.nextOrder);
      if (ids.length) this.journal.record('lots', rects, { ids, cause });
      return ids.length > 0 || keysMoved;
    }
    let same = this.items.size === source.items.size;
    if (same) {
      const theirs = source.items.values();
      for (const mine of this.items.values()) if (mine !== theirs.next().value) { same = false; break; }
    }
    if (same) return keysMoved;
    const keyList = this.keyList, keySet = this.keySet;
    this.reset();
    this.keyList = keyList;
    this.keySet = keySet;
    for (const lot of source.items.values()) this.append(lot);
    this.journal.record('lots', null, { cause });
    return true;
  }

  /** Every lot, its corners copied (the file, `RoadDoc.serialized`). */
  toJSON(): Lot[] {
    return [...this.items.values()].map((lot) => ({ ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) }));
  }

  /** @rebuild The whole store filed by place only on the first question after it was taken whole (a load, a copy). */
  private cells(): CellFiling<number, Lot> {
    if (!this.filing) {
      this.filing = new CellFiling<number, Lot>(LOT_CELL);
      for (const [id, lot] of this.items) this.filing.file(id, lot, lotBox(lot));
    }
    return this.filing;
  }

  /** A lot stored last in the order (`at`: the place number it keeps from a copy). */
  private append(lot: Lot, at?: number): void {
    this.items.set(lot.id, lot);
    this.order.set(lot.id, at ?? this.nextOrder++);
    this.filing?.file(lot.id, lot, lotBox(lot));
    this.listed = null;
  }

  private drop(id: number): void {
    this.items.delete(id);
    this.order.delete(id);
    this.filing?.remove(id);
    this.listed = null;
  }

  private reset(): void {
    this.items = new Map();
    this.order = new Map();
    this.nextOrder = 0;
    this.keyList = [];
    this.keySet = new Set();
    this.filing = null;
    this.listed = null;
  }
}
