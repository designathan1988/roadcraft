import type { Vec2 } from '@core/vec2';
import { lotCentre } from './lotRings';
import type { ChangeRect } from './changes';
import type { JournalCursor } from './derived';
import type { Lot } from './lotRecord';
import { LotStore } from './lotStore';
import { m } from './units';

/** THE OPEN LOTS (`RoadDoc.openLots`) */

/** What it reads of the document (`RoadDoc.openLots`), handed over by it */
export interface LotsHost {
  readonly lots: LotStore;
  /** Whether the building of this id stands; where it stands. */
  standing(id: number): boolean;
  place(id: number): Vec2 | null;
  /** The serial of the buildings' latest change, and the changes after a serial (null: some forgotten). */
  buildingsRevision(): number;
  buildingsSince(serial: number): readonly { readonly ids?: readonly number[] }[] | null;
}

/** Side of a cell of the centres' grid, world units: about the reach of the street filling along. */
const CELL = m(64);
const keyOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);
/** The least room the slots are laid with. */
const MIN_ROOM = 64;

export class OpenLots {
  /** The lot in each slot (undefined: a hole), as last read: the records are replaced, never changed, so identity tells a stale one. */
  private records: (Lot | undefined)[] = [];
  /** Each slot's place in the store's order (`LotStore.orderOf`) when it was taken. */
  private slotOrder: number[] = [];
  private readonly slotOf = new Map<number, number>();
  /** Each zoned lot's slot, by the cell of its centre; and the cell each slot is filed in (-1: none). */
  private readonly cells = new Map<number, Set<number>>();
  private cellOfSlot: number[] = [];
  /** The slots of the lots naming a building, by its id. */
  private readonly byBuilding = new Map<number, Set<number>>();
  private open = new Uint8Array(0);
  /** Fenwick tree of `open` over the whole room, 1-based (the slots past the last are zeros). */
  private tree = new Int32Array(1);
  /** The room: how many slots the arrays hold. */
  private room = 0;
  /** The highest power of two not above the room (where the descent starts). */
  private top = 0;
  private holes = 0;
  private openCount = 0;
  /** The highest id of a building standing on a lot, or -1; `lastStale`: to be found again before it is read. */
  private lastId = -1;
  private lastStale = false;
  private readonly cursor: JournalCursor = LotStore.cursor();
  private seenBuildings = -1;
  private refused: ReadonlySet<number> = new Set();
  private refusedSize = 0;

  constructor(private readonly host: LotsHost) {}

  /** How many lots are open, `refused` set aside. */
  count(refused: ReadonlySet<number>): number {
    this.sync(refused);
    return this.openCount;
  }

  /** The `k`-th open lot (from 0), in the lots' order. Asked after `count`. */
  at(k: number): Lot {
    if (k < 0 || k >= this.openCount) throw new RangeError(`open lot ${k} of ${this.openCount}`);
    let pos = 0, rest = k + 1;
    for (let step = this.top; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.room && this.tree[next]! < rest) { pos = next; rest -= this.tree[next]!; }
    }
    return this.records[pos]!;
  }

  /** The open lots whose centre may be within `reach` of `at` (a superset), in the lots' order. Asked after `count`. */
  near(at: Vec2, reach: number): Lot[] {
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
    if (this.lastStale) this.findLast();
    return this.lastId < 0 ? null : this.host.place(this.lastId);
  }

  /** `lot` took the building `id`: written in the document (`cause`, where), the index kept in step. */
  grew(lot: Lot, id: number, rects: readonly ChangeRect[] | null, cause: string): void {
    const slot = this.slotOf.get(lot.id);
    if (slot === undefined || this.records[slot] !== lot || this.host.lots.get(lot.id) !== lot) throw new Error(`lot ${lot.id} missing from the open lots' index`);
    const fresh: Lot = { ...lot, building: id };
    this.host.lots.apply({ put: [fresh], ...(rects ? { also: rects } : {}) }, cause);
    // Its own entry, read again at the next question, finds the slot as it is now.
    this.place(slot, fresh);
  }

  /** `lot` set aside: nothing fits it (`refused`, the set last asked with). */
  refuse(lot: Lot, refused: Set<number>): void {
    if (refused !== this.refused) throw new Error('refused lots of another set');
    refused.add(lot.id);
    this.refusedSize = refused.size;
    const slot = this.slotOf.get(lot.id);
    if (slot !== undefined) this.flag(slot);
  }

  private sync(refused: ReadonlySet<number>): void {
    const host = this.host;
    const lots = host.lots.changedFor(this.cursor);
    if (lots === null || refused !== this.refused || refused.size !== this.refusedSize) {
      this.rebuild(refused);
      return;
    }
    if (lots.length) {
      const last: Lot[] = [];
      for (const id of new Set(lots)) {
        const lot = host.lots.get(id);
        const slot = this.slotOf.get(id);
        if (slot !== undefined) {
          // Changed where it stands: the same slot. Gone, or put last in the store: a hole here.
          if (lot && host.lots.orderOf(id) === this.slotOrder[slot]) { if (this.records[slot] !== lot) this.place(slot, lot); continue; }
          this.clear(slot);
        }
        if (lot) last.push(lot);
      }
      if (this.records.length + last.length > this.room || this.holes > Math.max(MIN_ROOM, this.records.length - this.holes)) {
        this.rebuild(refused);
        return;
      }
      last.sort((a, b) => host.lots.orderOf(a.id)! - host.lots.orderOf(b.id)!);
      for (const lot of last) {
        const slot = this.records.length;
        this.records.push(undefined);
        this.slotOrder.push(host.lots.orderOf(lot.id)!);
        this.cellOfSlot.push(-1);
        this.slotOf.set(lot.id, slot);
        this.place(slot, lot);
      }
    }
    if (host.buildingsRevision() === this.seenBuildings) return;
    const entries = host.buildingsSince(this.seenBuildings);
    if (!entries || entries.some((e) => !e.ids)) { this.rebuild(refused); return; }
    for (const e of entries) for (const id of e.ids!) for (const slot of this.byBuilding.get(id) ?? []) this.flag(slot);
    this.seenBuildings = host.buildingsRevision();
  }

  /** A slot takes this record (its lot's new version, or a lot new to the slot): its cell, its building and its flag with it. */
  private place(slot: number, lot: Lot): void {
    const was = this.records[slot];
    if (was?.building !== lot.building) {
      if (was?.building !== undefined) this.unname(was.building, slot);
      if (lot.building !== undefined) {
        const named = this.byBuilding.get(lot.building);
        if (named) named.add(slot); else this.byBuilding.set(lot.building, new Set([slot]));
      }
    }
    this.records[slot] = lot;
    this.file(slot, lot.use ? cellOf(lot) : -1);
    this.flag(slot);
  }

  /** A slot left as a hole: its lot gone from the store, or put last there. */
  private clear(slot: number): void {
    const was = this.records[slot]!;
    if (was.building !== undefined) this.unname(was.building, slot);
    this.slotOf.delete(was.id);
    this.records[slot] = undefined;
    this.file(slot, -1);
    this.flag(slot);
    this.holes++;
  }

  private unname(building: number, slot: number): void {
    const named = this.byBuilding.get(building);
    named?.delete(slot);
    if (named?.size === 0) this.byBuilding.delete(building);
    if (building === this.lastId) this.lastStale = true;
  }

  private file(slot: number, key: number): void {
    const was = this.cellOfSlot[slot]!;
    if (was === key) return;
    if (was >= 0) {
      const cell = this.cells.get(was)!;
      cell.delete(slot);
      if (cell.size === 0) this.cells.delete(was);
    }
    if (key >= 0) {
      const cell = this.cells.get(key);
      if (cell) cell.add(slot); else this.cells.set(key, new Set([slot]));
    }
    this.cellOfSlot[slot] = key;
  }

  /** One slot's flag read again (its lot changed, a building of it came or went, it was set aside). */
  private flag(slot: number): void {
    const lot = this.records[slot];
    const b = lot?.building;
    const standing = b !== undefined && this.host.standing(b);
    const open = lot?.use && !standing && !this.refused.has(lot.id) ? 1 : 0;
    if (open !== this.open[slot]) {
      this.open[slot] = open;
      this.openCount += open ? 1 : -1;
      for (let i = slot + 1; i <= this.room; i += i & -i) this.tree[i] = this.tree[i]! + (open ? 1 : -1);
    }
    if (standing && b > this.lastId && !this.lastStale) this.lastId = b;
    else if (!standing && b === this.lastId) this.lastStale = true;
  }

  /** @rebuild Only when the building grown last is gone, or its lot. */
  private findLast(): void {
    let best = -1;
    for (const l of this.records) if (l?.building !== undefined && l.building > best && this.host.standing(l.building)) best = l.building;
    this.lastId = best;
    this.lastStale = false;
  }

  /** @rebuild The lots taken whole (a load, a copy), the buildings' diary forgotten, the set aside changed, or the slots laid again (the room ran out, the holes outnumber the lots): all read again. */
  private rebuild(refused: ReadonlySet<number>): void {
    const host = this.host;
    this.records = [...host.lots.all()];
    const n = this.records.length;
    this.room = Math.max(MIN_ROOM, 2 * n);
    this.slotOrder = this.records.map((lot) => host.lots.orderOf(lot!.id)!);
    this.cellOfSlot = new Array<number>(n).fill(-1);
    this.slotOf.clear(); this.cells.clear(); this.byBuilding.clear();
    this.open = new Uint8Array(this.room);
    this.tree = new Int32Array(this.room + 1);
    this.refused = refused;
    this.refusedSize = refused.size;
    this.openCount = 0;
    this.holes = 0;
    this.lastId = -1;
    this.lastStale = false;
    for (let slot = 0; slot < n; slot++) {
      const lot = this.records[slot]!;
      this.slotOf.set(lot.id, slot);
      const b = lot.building;
      const standing = b !== undefined && host.standing(b);
      if (b !== undefined) {
        const named = this.byBuilding.get(b);
        if (named) named.add(slot); else this.byBuilding.set(b, new Set([slot]));
        if (standing && b > this.lastId) this.lastId = b;
      }
      if (!lot.use) continue;
      this.file(slot, cellOf(lot));
      if (!standing && !refused.has(lot.id)) { this.open[slot] = 1; this.openCount++; }
    }
    // The tree in one pass: each node handing its sum on to its parent.
    for (let i = 1; i <= this.room; i++) {
      this.tree[i] = this.tree[i]! + this.open[i - 1]!;
      const up = i + (i & -i);
      if (up <= this.room) this.tree[up] = this.tree[up]! + this.tree[i]!;
    }
    for (this.top = 1; this.top * 2 <= this.room; this.top *= 2);
    // The diary read up to now: what came before is in the slots.
    host.lots.changedFor(this.cursor);
    this.seenBuildings = host.buildingsRevision();
  }
}

/** The cell of the centres' grid a lot's centre lies in. */
function cellOf(lot: Lot): number {
  const c = lotCentre(lot);
  return keyOf(Math.floor(c.x / CELL), Math.floor(c.y / CELL));
}
