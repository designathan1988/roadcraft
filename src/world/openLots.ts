import type { Vec2 } from '@core/vec2';
import { lotCentre } from './lotRings';
import type { ChangeRect } from './changes';
import { m } from './units';

/**
 * THE OPEN LOTS (`RoadDoc.openLots`): the zoned lots with no building
 * standing and not set aside, in the order of `doc.lots` and by place, for
 * the growth (`editor/zoning.ts` `growOnLot`). Every building grown read
 * every lot four times over - the open ones, the last grown, the nearest,
 * its own place in the list - a city of 80 000 lots 2.6·10¹⁰ reads.
 *
 * - "The k-th open lot" (the one drawn at random) is a descent of a Fenwick
 *   tree of the open flags: O(log n), the k-th in the list's order (Fenwick,
 *   "A new data structure for cumulative frequency tables", 1994;
 *   cp-algorithms, "Fenwick Tree").
 * - "The open lots round a point" read the cells of a grid of the lots'
 *   centres (Nystrom, "Spatial Partition"), in the list's order.
 *
 * Checked against the document at every question, never trusted: the lots
 * (`lotRevision`, which every writer moves), the buildings (the diary's
 * entries since, by id: one gone opens its lot again) and the set of lots
 * set aside (another set, or one emptied). What it cannot follow it makes
 * again from the list, as the loop it replaces did.
 * NÃO voltar a filtrar `doc.lots` a cada prédio crescido.
 */

/** A lot as it reads one (`world/lots.ts` `Lot`). */
export interface LotLike {
  readonly id: number;
  readonly corners: readonly Vec2[];
  readonly use?: string;
  readonly building?: number;
}

/**
 * What it reads of the document (`RoadDoc.openLots`), handed over by it: the
 * document imports this module, never the other way (no import cycle).
 */
export interface LotsHost<L extends LotLike> {
  readonly lots: L[];
  lotRevision(): number;
  /** Whether the building of this id stands; where it stands. */
  standing(id: number): boolean;
  place(id: number): Vec2 | null;
  /** The serial of the buildings' latest change, and the changes after a serial (null: some forgotten). */
  buildingsRevision(): number;
  buildingsSince(serial: number): readonly { readonly ids?: readonly number[] }[] | null;
  lotsChanged(rects: readonly ChangeRect[] | null, cause: string): void;
}

/** Side of a cell of the centres' grid, world units: about the reach of the street filling along. */
const CELL = m(64);
const keyOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

export class OpenLots<L extends LotLike> {
  /** The lots as last read, slot by slot (the records are replaced, never changed: identity tells a stale one). */
  private records: L[] = [];
  private readonly slotOf = new Map<number, number>();
  /** Each zoned lot's slot, by the cell of its centre, in the list's order. */
  private readonly cells = new Map<number, number[]>();
  /** The slots of the lots naming a building, by its id. */
  private readonly byBuilding = new Map<number, number[]>();
  private open = new Uint8Array(0);
  /** Fenwick tree of `open`, 1-based. */
  private tree = new Int32Array(0);
  /** The highest power of two not above the slot count (where the descent starts). */
  private top = 0;
  private openCount = 0;
  /** The highest id of a building standing on a lot, or -1. */
  private lastId = -1;
  private seenLots = -1;
  private seenBuildings = -1;
  private refused: ReadonlySet<number> = new Set();
  private refusedSize = 0;

  constructor(private readonly host: LotsHost<L>) {}

  /** How many lots are open, `refused` set aside. */
  count(refused: ReadonlySet<number>): number {
    this.sync(refused);
    return this.openCount;
  }

  /** The `k`-th open lot (from 0), in the list's order. Asked after `count`. */
  at(k: number): L {
    if (k < 0 || k >= this.openCount) throw new RangeError(`lote aberto ${k} de ${this.openCount}`);
    const n = this.records.length;
    let pos = 0, rest = k + 1;
    for (let step = this.top; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= n && this.tree[next]! < rest) { pos = next; rest -= this.tree[next]!; }
    }
    return this.records[pos]!;
  }

  /** The open lots whose centre may be within `reach` of `at` (a superset), in the list's order. Asked after `count`. */
  near(at: Vec2, reach: number): L[] {
    const found: number[] = [];
    for (let i = Math.floor((at.x - reach) / CELL); i <= Math.floor((at.x + reach) / CELL); i++) {
      for (let j = Math.floor((at.y - reach) / CELL); j <= Math.floor((at.y + reach) / CELL); j++) {
        for (const slot of this.cells.get(keyOf(i, j)) ?? []) if (this.open[slot]) found.push(slot);
      }
    }
    return found.sort((a, b) => a - b).map((slot) => this.records[slot]!);
  }

  /** Where the building grown last stands (the highest id standing on a lot), or null. Asked after `count`. */
  lastGrown(): Vec2 | null {
    return this.lastId < 0 ? null : this.host.place(this.lastId);
  }

  /** `lot` took the building `id`: written in the document (`cause`, where), the index kept in step. */
  grew(lot: L, id: number, rects: readonly ChangeRect[] | null, cause: string): void {
    const slot = this.slotOf.get(lot.id);
    if (slot === undefined || this.records[slot] !== lot || this.host.lots[slot] !== lot) throw new Error(`lote ${lot.id} fora do índice dos lotes abertos`);
    const fresh: L = { ...lot, building: id };
    this.host.lots[slot] = fresh;
    this.records[slot] = fresh;
    this.host.lotsChanged(rects, cause);
    this.seenLots = this.host.lotRevision();
    const named = this.byBuilding.get(id);
    if (named) named.push(slot);
    else this.byBuilding.set(id, [slot]);
    this.refresh(slot);
  }

  /** `lot` set aside: nothing fits it (`refused`, the set last asked with). */
  refuse(lot: L, refused: Set<number>): void {
    if (refused !== this.refused) throw new Error('lotes recusados de outro conjunto');
    refused.add(lot.id);
    this.refusedSize = refused.size;
    const slot = this.slotOf.get(lot.id);
    if (slot !== undefined) this.refresh(slot);
  }

  private sync(refused: ReadonlySet<number>): void {
    const host = this.host;
    if (host.lotRevision() !== this.seenLots || host.lots.length !== this.records.length || refused !== this.refused || refused.size !== this.refusedSize) {
      this.rebuild(refused);
      return;
    }
    if (host.buildingsRevision() === this.seenBuildings) return;
    const entries = host.buildingsSince(this.seenBuildings);
    if (!entries || entries.some((e) => !e.ids)) { this.rebuild(refused); return; }
    for (const e of entries) for (const id of e.ids!) for (const slot of this.byBuilding.get(id) ?? []) this.refresh(slot);
    this.seenBuildings = host.buildingsRevision();
  }

  /** One lot's flag read again (a building of it came or went, it was set aside). */
  private refresh(slot: number): void {
    const lot = this.records[slot]!;
    const b = lot.building;
    const standing = b !== undefined && this.host.standing(b);
    const open = lot.use && !standing && !this.refused.has(lot.id) ? 1 : 0;
    if (open !== this.open[slot]) {
      this.open[slot] = open;
      this.openCount += open ? 1 : -1;
      for (let i = slot + 1; i <= this.records.length; i += i & -i) this.tree[i] = this.tree[i]! + (open ? 1 : -1);
    }
    if (standing && b > this.lastId) this.lastId = b;
    else if (!standing && b === this.lastId) this.lastId = this.highestStanding();
  }

  /** @rebuild Only when the building grown last is gone. */
  private highestStanding(): number {
    let best = -1;
    for (const l of this.records) if (l.building !== undefined && l.building > best && this.host.standing(l.building)) best = l.building;
    return best;
  }

  /** @rebuild The lots, the buildings or the set aside changed in a way it does not follow: all read again. */
  private rebuild(refused: ReadonlySet<number>): void {
    const host = this.host;
    this.records = [...host.lots];
    const n = this.records.length;
    this.slotOf.clear(); this.cells.clear(); this.byBuilding.clear();
    this.open = new Uint8Array(n);
    this.tree = new Int32Array(n + 1);
    this.refused = refused;
    this.refusedSize = refused.size;
    this.openCount = 0;
    this.lastId = -1;
    for (let slot = 0; slot < n; slot++) {
      const lot = this.records[slot]!;
      this.slotOf.set(lot.id, slot);
      const b = lot.building;
      const standing = b !== undefined && host.standing(b);
      if (b !== undefined) {
        const named = this.byBuilding.get(b);
        if (named) named.push(slot);
        else this.byBuilding.set(b, [slot]);
        if (standing && b > this.lastId) this.lastId = b;
      }
      if (!lot.use) continue;
      const c = lotCentre(lot), key = keyOf(Math.floor(c.x / CELL), Math.floor(c.y / CELL));
      const cell = this.cells.get(key);
      if (cell) cell.push(slot);
      else this.cells.set(key, [slot]);
      if (!standing && !refused.has(lot.id)) { this.open[slot] = 1; this.openCount++; }
    }
    // The tree in one pass: each node handing its sum on to its parent.
    for (let i = 1; i <= n; i++) {
      this.tree[i] = this.tree[i]! + this.open[i - 1]!;
      const up = i + (i & -i);
      if (up <= n) this.tree[up] = this.tree[up]! + this.tree[i]!;
    }
    this.top = 0;
    if (n > 0) for (this.top = 1; this.top * 2 <= n; this.top *= 2);
    this.seenLots = host.lotRevision();
    this.seenBuildings = host.buildingsRevision();
  }
}
