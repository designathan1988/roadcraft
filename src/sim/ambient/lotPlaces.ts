import { grown } from '@core/idSlots';
import type { ChangeJournal, ChangeRect } from '@world/changes';
import { m } from '@world/units';
import type { TrafficBuilding, TrafficBuildings, TrafficFacts } from '../agents/trafficBuildings';
import { ambientIndexWork, atRoll, cellKey, type Kind } from './ambientIndex';


/** Whole-number weights in a Fenwick tree */
class Fenwick {
  private cap = 16;
  private tree = new Float64Array(this.cap + 1);
  private raw = new Float64Array(this.cap);
  /** The sum of every weight. */
  total = 0;

  get(i: number): number {
    return i < this.cap ? this.raw[i]! : 0;
  }

  set(i: number, value: number): void {
    if (i >= this.cap) this.grow(i);
    const delta = value - this.raw[i]!;
    if (delta === 0) return;
    this.raw[i] = value;
    this.total += delta;
    for (let j = i + 1; j <= this.cap; j += j & -j) this.tree[j] = this.tree[j]! + delta;
  }

  /** The first item whose running sum passes `v` (0 <= v < total); -1 when none does. */
  find(v: number): number {
    let pos = 0, rem = v;
    for (let step = this.cap; step > 0; step >>= 1) {
      if (pos + step <= this.cap && this.tree[pos + step]! <= rem) { pos += step; rem -= this.tree[pos]!; }
    }
    return pos < this.cap ? pos : -1;
  }

  /** @rebuild Twice the room, the tree laid again from the weights (each item's room doubles at most once per doubling). */
  private grow(i: number): void {
    let cap = this.cap;
    while (cap <= i) cap *= 2;
    const raw = new Float64Array(cap);
    raw.set(this.raw);
    const tree = new Float64Array(cap + 1);
    for (let j = 1; j <= cap; j++) {
      tree[j] = tree[j]! + raw[j - 1]!;
      const up = j + (j & -j);
      if (up <= cap) tree[up] = tree[up]! + tree[j]!;
    }
    this.cap = cap;
    this.raw = raw;
    this.tree = tree;
  }
}

/** The kinds of place, in the order of the trees and of the coefficients a draw is given. */
export const PLACE_KINDS: readonly Kind[] = ['home', 'shop', 'work', 'civic'];
const KIND_INDEX: Record<Kind, number> = { home: 0, shop: 1, work: 2, civic: 3 };
/** Weights are frontages in millionths of a unit, whole: a frontage of 6 m or more moves by less than one part in six million. */
const WEIGHT_SCALE = 1e6;
const weightOf = (frontage: number): number => Math.max(0, Math.round(frontage * WEIGHT_SCALE));
/** The side of a place cell, for the walk from one lot to another. */
const PLACE_CELL = m(256);
/** How far past a building's box (`storedBounds`: its blocks and its lot's parts) the foot of its way can be */
const FEET_PAD = m(2);
/** How far round a road edit a street door's foot is looked at again */
const ROAD_REACH = m(60);
/** Proposals a draw makes before it gives up (`LotPlaces.pick`). */
const MAX_PROPOSALS = 64;

/** A lot's way on foot from its door to the footway (`agents/lotDoors.ts` DoorWay). */
export interface PlaceWay {
  readonly building: number;
  readonly out: readonly { readonly x: number; readonly y: number }[];
  readonly frontage: number;
  readonly street?: true;
}

/** What the places are worked out with: the lot's way (`lotDoors.ts` doorWay); its bound is the store's (`TrafficFacts.frontage`). */
export interface PlaceDeps<W extends PlaceWay> {
  readonly wayOf: (b: TrafficBuilding) => W | null;
}

interface PlaceCell {
  /** Its members' places. */
  readonly members: number[];
  /** Weights of its members by kind. */
  readonly sums: number[];
  /** Where its members' feet can be: grown as members come, never shrunk (a box too wide only bounds loosely). */
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * DO NOT go back to working out lots' ways by a time budget a look.
 * DO NOT hold a place an object, nor its building's traffic record: each place is a number, its building, kind, bound, weight, slot in
 * its kind's tree, cell and feet in columns; its building's record asked of the store when its way is worked out (`workOut`).
 */
export class LotPlaces<W extends PlaceWay> {
  /** The diary read by serial, not followed (a reader that stops reading would keep every entry after it). */
  private serial = -1;
  /** The store last read: a way is worked out from its building's traffic record, asked when drawn. */
  private store: TrafficBuildings | null = null;
  /** Each building's place, in the order they were filed. */
  private readonly byBuilding = new Map<number, number>();
  private readonly trees = PLACE_KINDS.map(() => new Fenwick());
  /** Each kind's tree's slots' places (-1: none). */
  private readonly slots: number[][] = PLACE_KINDS.map(() => []);
  private readonly freeSlots: number[][] = PLACE_KINDS.map(() => []);
  private readonly cells = new Map<number, PlaceCell>();
  /** The places whose way is a street door's (good or footless): looked at again when the roads near change. */
  private readonly streetish = new Set<number>();
  /** The farthest a member's feet reach from the middle its cell is chosen by (grown, never shrunk). */
  private spread = 0;
  // Each place's columns: its building, kind (`PLACE_KINDS`), the most frontage its way can have as a weight (what it is drawn by until
  // its way is worked out), its weight in its kind's tree now (the bound, its way's frontage, or 0), its slot there, its cell (NaN: none)
  // and its place in the cell's members, where its way's foot can be (x0, y0, x1, y1), and its way (undefined until worked out; null
  // when nobody walks to it).
  private building = new Float64Array(16);
  private kind = new Uint8Array(16);
  private bound = new Float64Array(16);
  private weight = new Float64Array(16);
  private slot = new Int32Array(16);
  private cell = new Float64Array(16);
  private cellAt = new Int32Array(16);
  private feet = new Float64Array(64);
  private ways: (W | null | undefined)[] = [];
  private placeCount = 0;
  private freePlaces: number[] = [];

  constructor(private readonly deps: PlaceDeps<W>) {}

  /** Takes in the buildings and the roads the diary says changed since the last call. */
  sync(store: TrafficBuildings, journal: ChangeJournal): void {
    this.store = store;
    if (this.serial >= journal.version) return;
    const entries = journal.since(this.serial, ['buildings', 'roads']);
    this.serial = journal.version;
    if (!entries) { this.fileAll(store); return; }
    const ids = new Set<number>();
    const rects: ChangeRect[] = [];
    let everyRoad = false;
    for (const entry of entries) {
      if (entry.kind === 'buildings') {
        if (!entry.ids) { this.fileAll(store); return; }
        for (const id of entry.ids) ids.add(id);
      } else if (!entry.rects) everyRoad = true;
      else rects.push(...entry.rects);
    }
    for (const id of ids) {
      this.unfile(id);
      const b = store.facts(id as never);
      if (b) this.file(b);
    }
    // A street door's way holds while a footway is at its foot
    if (everyRoad) { for (const p of [...this.streetish]) this.unknown(p); return; }
    const feet = this.feet;
    for (const r of rects) {
      const x0 = r[0] - ROAD_REACH, y0 = r[1] - ROAD_REACH, x1 = r[2] + ROAD_REACH, y1 = r[3] + ROAD_REACH;
      // A member's feet reach `spread` from the middle its cell is chosen by.
      const cx0 = Math.floor((x0 - this.spread) / PLACE_CELL), cx1 = Math.floor((x1 + this.spread) / PLACE_CELL);
      const cy0 = Math.floor((y0 - this.spread) / PLACE_CELL), cy1 = Math.floor((y1 + this.spread) / PLACE_CELL);
      const look = (c: PlaceCell): void => {
        ambientIndexWork.cells++;
        if (c.x1 < x0 || c.x0 > x1 || c.y1 < y0 || c.y0 > y1) return;
        for (const p of [...c.members]) {
          const at = p * 4;
          if (!this.streetish.has(p) || feet[at + 2]! < x0 || feet[at]! > x1 || feet[at + 3]! < y0 || feet[at + 1]! > y1) continue;
          this.unknown(p);
        }
      };
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cells.size) { for (const c of this.cells.values()) look(c); continue; }
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gy = cy0; gy <= cy1; gy++) {
          const c = this.cells.get(cellKey(gx, gy));
          if (c) look(c);
        }
      }
    }
  }

  /** Whether any lot may be walked to (one whose way is not yet known counts). */
  ready(): boolean {
    for (const tree of this.trees) if (tree.total > 0) return true;
    return false;
  }

  /** The frontage of the lots that may be walked to, by kind (`PLACE_KINDS` order), world units. */
  frontages(): number[] {
    return this.trees.map((tree) => tree.total / WEIGHT_SCALE);
  }

  /** A building's way as a place (worked out now if it was not yet); undefined for a building not filed. */
  wayOf(id: number, joins: (p: { x: number; y: number }) => boolean): W | null | undefined {
    const p = this.byBuilding.get(id);
    if (p === undefined) return undefined;
    if (this.ways[p] === undefined) this.workOut(p, joins);
    return this.ways[p];
  }

  /** A lot drawn by `coef[kind] x frontage`, or, given `not` */
  pick(rng: { float(): number }, coef: readonly number[], not: W | null, joins: (p: { x: number; y: number }) => boolean,
    decay: number, near: number): W | null {
    return not ? this.pickFrom(rng, coef, not, joins, decay, near) : this.pickAny(rng, coef, joins);
  }

  private pickAny(rng: { float(): number }, coef: readonly number[], joins: (p: { x: number; y: number }) => boolean): W | null {
    for (let t = 0; t < MAX_PROPOSALS; t++) {
      let all = 0;
      for (let k = 0; k < PLACE_KINDS.length; k++) all += coef[k]! * this.trees[k]!.total;
      if (!(all > 0)) return null;
      let roll = rng.float() * all, k = -1;
      for (let j = 0; j < PLACE_KINDS.length; j++) {
        const part = coef[j]! * this.trees[j]!.total;
        if (!(part > 0)) continue;
        k = j;
        if (roll < part) break;
        roll -= part;
      }
      const tree = this.trees[k]!;
      const slot = tree.find(Math.min(roll / coef[k]!, tree.total - 0.5));
      const p = slot < 0 ? -1 : this.slots[k]![slot] ?? -1;
      if (p < 0 || this.weight[p]! <= 0) continue;
      ambientIndexWork.proposals++;
      const was = this.weight[p]!;
      if (this.ways[p] === undefined) this.workOut(p, joins);
      const way = this.ways[p];
      if (!way) continue;
      // Taken with the chance of its frontage over the weight it was drawn by.
      if (this.weight[p]! >= was || rng.float() * was < this.weight[p]!) return way;
    }
    return null;
  }

  private pickFrom(rng: { float(): number }, coef: readonly number[], not: W, joins: (p: { x: number; y: number }) => boolean,
    decay: number, near: number): W | null {
    const foot = not.out[not.out.length - 1]!;
    // Each cell drawn by its weight times the nearest its feet can be (a bound of every member's own distance decay)
    const cells: PlaceCell[] = [];
    const bounds: number[] = [];
    let sum = 0;
    for (const c of this.cells.values()) {
      ambientIndexWork.cells++;
      let weight = 0;
      for (let k = 0; k < PLACE_KINDS.length; k++) weight += coef[k]! * c.sums[k]!;
      if (!(weight > 0)) continue;
      const far = Math.hypot(Math.max(foot.x - c.x0, c.x1 - foot.x), Math.max(foot.y - c.y0, c.y1 - foot.y));
      if (far < near) continue;
      const nearest = Math.hypot(Math.max(c.x0 - foot.x, 0, foot.x - c.x1), Math.max(c.y0 - foot.y, 0, foot.y - c.y1));
      const bound = Math.exp(-nearest / decay) * weight;
      if (!(bound > 0)) continue;
      cells.push(c);
      bounds.push(bound);
      sum += bound;
    }
    if (!(sum > 0)) return null;
    const running = new Float64Array(bounds.length);
    let acc = 0;
    bounds.forEach((b, i) => { acc += b; running[i] = acc; });
    for (let t = 0; t < MAX_PROPOSALS; t++) {
      const at = atRoll(running, rng.float() * acc);
      const c = cells[at]!;
      let weight = 0;
      for (let k = 0; k < PLACE_KINDS.length; k++) weight += coef[k]! * c.sums[k]!;
      if (!(weight > 0)) continue;
      let roll = rng.float() * weight;
      let p = -1;
      for (const q of c.members) {
        const part = coef[this.kind[q]!]! * this.weight[q]!;
        if (!(part > 0)) continue;
        p = q;
        if (roll < part) break;
        roll -= part;
      }
      if (p < 0) continue;
      ambientIndexWork.proposals++;
      const was = this.weight[p]!;
      if (this.ways[p] === undefined) this.workOut(p, joins);
      const way = this.ways[p];
      if (!way || way === not || this.weight[p]! <= 0) continue;
      const end = way.out[way.out.length - 1]!;
      const d = Math.hypot(end.x - foot.x, end.y - foot.y);
      if (d < near) continue;
      const chance = (this.weight[p]! / was) * Math.exp(-d / decay) * weight / bounds[at]!;
      if (chance > 1) ambientIndexWork.boundBroken++;
      if (rng.float() < chance) return way;
    }
    return null;
  }

  /** The lot's way worked out (`lotDoors.ts`) from its building's traffic record, its weight from now on its frontage (0: nobody walks to it). */
  private workOut(p: number, joins: (p: { x: number; y: number }) => boolean): void {
    ambientIndexWork.verified++;
    const b = this.store?.get(this.building[p]! as never);
    const way = b ? this.deps.wayOf(b) : null;
    const footless = !!way?.street && !joins(way.out[way.out.length - 1]!);
    const kept = footless ? null : way;
    this.ways[p] = kept;
    if (way?.street) this.streetish.add(p);
    const weight = kept ? weightOf(kept.frontage) : 0;
    if (weight > this.weight[p]!) ambientIndexWork.boundBroken++;
    if (kept) {
      const end = kept.out[kept.out.length - 1]!, at = p * 4, feet = this.feet;
      if (end.x < feet[at]! || end.x > feet[at + 2]! || end.y < feet[at + 1]! || end.y > feet[at + 3]!) ambientIndexWork.boundBroken++;
    }
    this.weigh(p, weight);
  }

  /** Back to not known: drawn by its bound until worked out again. */
  private unknown(p: number): void {
    this.ways[p] = undefined;
    this.streetish.delete(p);
    this.weigh(p, this.bound[p]!);
  }

  private weigh(p: number, weight: number): void {
    const k = this.kind[p]!;
    this.trees[k]!.set(this.slot[p]!, weight);
    const cell = this.cell[p]!;
    if (!Number.isNaN(cell)) {
      const sums = this.cells.get(cell)!.sums;
      sums[k] = sums[k]! + weight - this.weight[p]!;
    }
    this.weight[p] = weight;
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. By the buildings' facts alone (`TrafficFacts`): no traffic record worked out for them. */
  private fileAll(store: TrafficBuildings): void {
    ambientIndexWork.full++;
    for (const id of [...this.byBuilding.keys()]) this.unfile(id);
    store.eachFacts((b) => this.file(b));
  }

  private newPlace(): number {
    const p = this.freePlaces.length ? this.freePlaces.pop()! : this.placeCount++;
    if (p >= this.building.length) {
      const n = Math.ceil(this.building.length * 1.5);
      this.building = grown(this.building, n); this.kind = grown(this.kind, n); this.bound = grown(this.bound, n);
      this.weight = grown(this.weight, n); this.slot = grown(this.slot, n); this.cell = grown(this.cell, n);
      this.cellAt = grown(this.cellAt, n); this.feet = grown(this.feet, n * 4);
    }
    while (this.ways.length <= p) this.ways.push(undefined);
    return p;
  }

  private file(b: TrafficFacts): void {
    ambientIndexWork.filed++;
    const k = KIND_INDEX[b.kind];
    const bound = weightOf(b.frontage);
    const box = b.bounds;
    const placed = Number.isFinite(box.minX) && Number.isFinite(box.maxX) && Number.isFinite(box.minY) && Number.isFinite(box.maxY);
    const fx0 = box.minX - FEET_PAD, fy0 = box.minY - FEET_PAD, fx1 = box.maxX + FEET_PAD, fy1 = box.maxY + FEET_PAD;
    const cell = placed ? cellKey(Math.floor((fx0 + fx1) / 2 / PLACE_CELL), Math.floor((fy0 + fy1) / 2 / PLACE_CELL)) : null;
    const free = this.freeSlots[k]!;
    const slot = free.length ? free.pop()! : this.slots[k]!.length;
    const p = this.newPlace();
    this.building[p] = b.id; this.kind[p] = k; this.bound[p] = bound; this.weight[p] = 0; this.slot[p] = slot;
    this.cell[p] = cell ?? Number.NaN; this.cellAt[p] = -1; this.ways[p] = undefined;
    const feet = this.feet, at = p * 4;
    feet[at] = fx0; feet[at + 1] = fy0; feet[at + 2] = fx1; feet[at + 3] = fy1;
    this.slots[k]![slot] = p;
    this.byBuilding.set(b.id, p);
    if (cell !== null) {
      this.spread = Math.max(this.spread, (fx1 - fx0) / 2, (fy1 - fy0) / 2);
      let c = this.cells.get(cell);
      if (!c) this.cells.set(cell, c = { members: [], sums: [0, 0, 0, 0], x0: fx0, y0: fy0, x1: fx1, y1: fy1 });
      c.x0 = Math.min(c.x0, fx0); c.y0 = Math.min(c.y0, fy0); c.x1 = Math.max(c.x1, fx1); c.y1 = Math.max(c.y1, fy1);
      this.cellAt[p] = c.members.length;
      c.members.push(p);
    }
    this.weigh(p, bound);
  }

  private unfile(id: number): void {
    const p = this.byBuilding.get(id);
    if (p === undefined) return;
    this.weigh(p, 0);
    this.byBuilding.delete(id);
    this.streetish.delete(p);
    const k = this.kind[p]!;
    this.slots[k]![this.slot[p]!] = -1;
    this.freeSlots[k]!.push(this.slot[p]!);
    this.ways[p] = undefined;
    this.freePlaces.push(p);
    const cell = this.cell[p]!;
    if (Number.isNaN(cell)) return;
    const c = this.cells.get(cell)!;
    const last = c.members.pop()!;
    if (last !== p) { c.members[this.cellAt[p]!] = last; this.cellAt[last] = this.cellAt[p]!; }
    if (!c.members.length) this.cells.delete(cell);
  }
}
