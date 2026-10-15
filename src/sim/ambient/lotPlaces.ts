import type { ChangeJournal, ChangeRect } from '@world/changes';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingElement } from '@world/buildings/types';
import { storedBounds } from '@world/buildings/geometry';
import { m } from '@world/units';
import { kindOf } from './demand';
import { ambientIndexWork, atRoll, cellKey, type Kind } from './ambientIndex';


/**
 * Whole-number weights in a Fenwick tree (binary indexed tree; Fenwick, "A
 * new data structure for cumulative frequency tables", 1994;
 * en.wikipedia.org/wiki/Fenwick_tree): a weight set and the item a roll
 * falls on, both in O(log n). Whole numbers, so adding and taking away never
 * leaves a rounding behind.
 */
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
/**
 * How far past a building's box (`storedBounds`: its blocks and its lot's
 * parts) the foot of its way can be: a gate's foot is 0.6 m out of the gate,
 * a street door's 1.05 m out of the facade.
 */
const FEET_PAD = m(2);
/**
 * How far round a road edit a street door's foot is looked at again: past
 * the widest road's half and its footway, the corners of the junctions at
 * its ends, and the 4 m a foot joins a footway within.
 */
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

/** What the places are worked out with: the lot's way (`lotDoors.ts` doorWay) and its people's gates (`personGates`). */
export interface PlaceDeps<W extends PlaceWay> {
  readonly wayOf: (b: Building) => W | null;
  readonly gatesOf: (b: Building) => readonly BuildingElement[];
}

interface Place<W extends PlaceWay> {
  readonly b: Building;
  readonly k: number;
  /** The most frontage its way can have, as a weight: what it is drawn by until its way is worked out. */
  readonly bound: number;
  /** Undefined until worked out; null when nobody walks to it. */
  way: W | null | undefined;
  /** A street door with no footway at its foot. */
  footless: boolean;
  /** Its weight in its kind's tree now: the bound, its way's frontage, or 0. */
  weight: number;
  readonly slot: number;
  readonly cell: number | null;
  cellAt: number;
  /** Where its way's foot can be. */
  readonly fx0: number; readonly fy0: number; readonly fx1: number; readonly fy1: number;
}

interface PlaceCell<W extends PlaceWay> {
  readonly members: Place<W>[];
  /** Weights of its members by kind. */
  readonly sums: number[];
  /** Where its members' feet can be: grown as members come, never shrunk (a box too wide only bounds loosely). */
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * The buildings people walk into (`ambient.ts` edgePeople), kept by the
 * diary: one place per building, by its id, and drawn by weight in O(log n)
 * - a Fenwick tree per kind - instead of a walk over every building twice
 * a person made.
 *
 * A lot's way from its door (`lotDoors.ts` doorWay, a millisecond or so: a
 * person's grid round the gate) is worked out only when the lot is drawn,
 * and kept with the record. Until then the lot is drawn by the most
 * frontage its way can have (its blocks across each of its people's gates,
 * or along its facade); the lot drawn is then worked out and taken with the
 * chance of its frontage over that bound, else drawn again - rejection
 * sampling (en.wikipedia.org/wiki/Rejection_sampling): each lot comes out
 * with the chance of its own frontage, as the walk over every worked-out
 * lot drew it. DO NOT go back to working out lots' ways by a time budget a
 * look: the clock decided which lots were known, so where people walked,
 * and a town of 20 000 lots was known after twenty minutes.
 */
export class LotPlaces<W extends PlaceWay> {
  private serial = -1;
  private readonly byBuilding = new Map<number, Place<W>>();
  private readonly trees = PLACE_KINDS.map(() => new Fenwick());
  private readonly slots: (Place<W> | undefined)[][] = PLACE_KINDS.map(() => []);
  private readonly freeSlots: number[][] = PLACE_KINDS.map(() => []);
  private readonly cells = new Map<number, PlaceCell<W>>();
  /** The places whose way is a street door's (good or footless): looked at again when the roads near change. */
  private readonly streetish = new Set<Place<W>>();
  /** The farthest a member's feet reach from the middle its cell is chosen by (grown, never shrunk). */
  private spread = 0;

  constructor(private readonly deps: PlaceDeps<W>) {}

  /** Takes in the buildings and the roads the diary says changed since the last call. */
  sync(store: BuildingStore, journal: ChangeJournal): void {
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
      const b = store.get(id as never);
      if (b) this.file(b);
    }
    // A street door's way holds while a footway is at its foot: the roads
    // changed near it, it is worked out again when next drawn.
    if (everyRoad) { for (const p of [...this.streetish]) this.unknown(p); return; }
    for (const r of rects) {
      const x0 = r[0] - ROAD_REACH, y0 = r[1] - ROAD_REACH, x1 = r[2] + ROAD_REACH, y1 = r[3] + ROAD_REACH;
      // A member's feet reach `spread` from the middle its cell is chosen by.
      const cx0 = Math.floor((x0 - this.spread) / PLACE_CELL), cx1 = Math.floor((x1 + this.spread) / PLACE_CELL);
      const cy0 = Math.floor((y0 - this.spread) / PLACE_CELL), cy1 = Math.floor((y1 + this.spread) / PLACE_CELL);
      const look = (c: PlaceCell<W>): void => {
        ambientIndexWork.cells++;
        if (c.x1 < x0 || c.x0 > x1 || c.y1 < y0 || c.y0 > y1) return;
        for (const p of [...c.members]) {
          if (!this.streetish.has(p) || p.fx1 < x0 || p.fx0 > x1 || p.fy1 < y0 || p.fy0 > y1) continue;
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
    if (!p) return undefined;
    if (p.way === undefined) this.workOut(p, joins);
    return p.way;
  }

  /**
   * A lot drawn by `coef[kind] x frontage`, or, given `not` (the other end of
   * a walk), by that times e^(-d/decay), d the distance between the feet of
   * their ways, none nearer than `near`. Null when there is none (or when
   * `MAX_PROPOSALS` were turned down: not one in a billion in a town).
   * `joins`: whether a street door's foot is on a footway.
   */
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
      const p = slot < 0 ? undefined : this.slots[k]![slot];
      if (!p || p.weight <= 0) continue;
      ambientIndexWork.proposals++;
      const was = p.weight;
      if (p.way === undefined) this.workOut(p, joins);
      if (!p.way) continue;
      // Taken with the chance of its frontage over the weight it was drawn by.
      if (p.weight >= was || rng.float() * was < p.weight) return p.way;
    }
    return null;
  }

  private pickFrom(rng: { float(): number }, coef: readonly number[], not: W, joins: (p: { x: number; y: number }) => boolean,
    decay: number, near: number): W | null {
    const foot = not.out[not.out.length - 1]!;
    // Each cell drawn by its weight times the nearest its feet can be (a
    // bound of every member's own distance decay); a member by its weight;
    // taken with the chance of its frontage, decay and the cell's weight now
    // over what it was drawn by: each lot comes out with the chance of its
    // own weight times its own decay, as the walk over every lot drew it.
    const cells: PlaceCell<W>[] = [];
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
      let p: Place<W> | undefined;
      for (const q of c.members) {
        const part = coef[q.k]! * q.weight;
        if (!(part > 0)) continue;
        p = q;
        if (roll < part) break;
        roll -= part;
      }
      if (!p) continue;
      ambientIndexWork.proposals++;
      const was = p.weight;
      if (p.way === undefined) this.workOut(p, joins);
      if (!p.way || p.way === not || p.weight <= 0) continue;
      const end = p.way.out[p.way.out.length - 1]!;
      const d = Math.hypot(end.x - foot.x, end.y - foot.y);
      if (d < near) continue;
      const chance = (p.weight / was) * Math.exp(-d / decay) * weight / bounds[at]!;
      if (chance > 1) ambientIndexWork.boundBroken++;
      if (rng.float() < chance) return p.way;
    }
    return null;
  }

  /** The lot's way worked out (`lotDoors.ts`), its weight from now on its frontage (0: nobody walks to it). */
  private workOut(p: Place<W>, joins: (p: { x: number; y: number }) => boolean): void {
    ambientIndexWork.verified++;
    const way = this.deps.wayOf(p.b);
    const footless = !!way?.street && !joins(way.out[way.out.length - 1]!);
    p.way = footless ? null : way;
    p.footless = footless;
    if (way?.street) this.streetish.add(p);
    const weight = p.way ? weightOf(p.way.frontage) : 0;
    if (weight > p.weight) ambientIndexWork.boundBroken++;
    if (p.way) {
      const end = p.way.out[p.way.out.length - 1]!;
      if (end.x < p.fx0 || end.x > p.fx1 || end.y < p.fy0 || end.y > p.fy1) ambientIndexWork.boundBroken++;
    }
    this.weigh(p, weight);
  }

  /** Back to not known: drawn by its bound until worked out again. */
  private unknown(p: Place<W>): void {
    p.way = undefined;
    p.footless = false;
    this.streetish.delete(p);
    this.weigh(p, p.bound);
  }

  private weigh(p: Place<W>, weight: number): void {
    this.trees[p.k]!.set(p.slot, weight);
    if (p.cell !== null) {
      const sums = this.cells.get(p.cell)!.sums;
      sums[p.k] = sums[p.k]! + weight - p.weight;
    }
    p.weight = weight;
  }

  /** @rebuild The whole store read again: a load, a clear, or a diary that forgot. */
  private fileAll(store: BuildingStore): void {
    ambientIndexWork.full++;
    for (const id of [...this.byBuilding.keys()]) this.unfile(id);
    for (const b of store.all()) this.file(b);
  }

  private file(b: Building): void {
    ambientIndexWork.filed++;
    const k = KIND_INDEX[kindOf(b)];
    const bound = weightOf(this.frontageBound(b));
    const box = storedBounds(b);
    const placed = Number.isFinite(box.minX) && Number.isFinite(box.maxX) && Number.isFinite(box.minY) && Number.isFinite(box.maxY);
    const fx0 = box.minX - FEET_PAD, fy0 = box.minY - FEET_PAD, fx1 = box.maxX + FEET_PAD, fy1 = box.maxY + FEET_PAD;
    const cell = placed ? cellKey(Math.floor((fx0 + fx1) / 2 / PLACE_CELL), Math.floor((fy0 + fy1) / 2 / PLACE_CELL)) : null;
    const free = this.freeSlots[k]!;
    const slot = free.length ? free.pop()! : this.slots[k]!.length;
    const p: Place<W> = { b, k, bound, way: undefined, footless: false, weight: 0, slot, cell, cellAt: -1, fx0, fy0, fx1, fy1 };
    this.slots[k]![slot] = p;
    this.byBuilding.set(b.id, p);
    if (cell !== null) {
      this.spread = Math.max(this.spread, (fx1 - fx0) / 2, (fy1 - fy0) / 2);
      let c = this.cells.get(cell);
      if (!c) this.cells.set(cell, c = { members: [], sums: [0, 0, 0, 0], x0: fx0, y0: fy0, x1: fx1, y1: fy1 });
      c.x0 = Math.min(c.x0, fx0); c.y0 = Math.min(c.y0, fy0); c.x1 = Math.max(c.x1, fx1); c.y1 = Math.max(c.y1, fy1);
      p.cellAt = c.members.length;
      c.members.push(p);
    }
    this.weigh(p, bound);
  }

  private unfile(id: number): void {
    const p = this.byBuilding.get(id);
    if (!p) return;
    this.weigh(p, 0);
    this.byBuilding.delete(id);
    this.streetish.delete(p);
    this.slots[p.k]![p.slot] = undefined;
    this.freeSlots[p.k]!.push(p.slot);
    if (p.cell === null) return;
    const c = this.cells.get(p.cell)!;
    const last = c.members.pop()!;
    if (last !== p) { c.members[p.cellAt] = last; last.cellAt = p.cellAt; }
    if (!c.members.length) this.cells.delete(p.cell);
  }

  /**
   * The most frontage the building's way can have (`lotDoors.ts`): through a
   * people's gate, its blocks' width across that gate, the widest of its
   * gates; with none, by its street door, its blocks' width along the
   * facade. At least 6 m, as there.
   */
  private frontageBound(b: Building): number {
    const gates = this.deps.gatesOf(b);
    if (!gates.length) {
      let lo = Infinity, hi = -Infinity;
      for (const v of b.volumes) { lo = Math.min(lo, v.x); hi = Math.max(hi, v.x + v.w); }
      return Math.max(m(6), hi - lo);
    }
    let best = 0;
    for (const g of gates) {
      const alongY = g.facing === 1 || g.facing === 3;
      let ux = alongY ? 0 : 1, uy = alongY ? 1 : 0;
      if (g.angle) {
        const c = Math.cos(g.angle), s = Math.sin(g.angle);
        [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
      }
      let lo = Infinity, hi = -Infinity;
      for (const v of b.volumes) {
        for (const [x, y] of [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.d], [v.x + v.w, v.y + v.d]] as const) {
          const a = (x - g.x) * ux + (y - g.y) * uy;
          lo = Math.min(lo, a); hi = Math.max(hi, a);
        }
      }
      best = Math.max(best, Math.max(m(6), hi - lo));
    }
    return best;
  }
}
