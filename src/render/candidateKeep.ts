import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/**
 * WHICH OF A SWEEP'S PLACES STAND, KEPT PLACE BY PLACE (`renderer.ts`, the
 * plants and stones): each place of a sweep - a tree, a bush, a stone where
 * one may stand - is tested once, and again only when a change of what the
 * test reads (the roads, the buildings' ground, the clearings, the land)
 * reached it: the places are filed by cell once per sweep, and a change's
 * rectangles find theirs. Whether a place stands is its own test alone - no
 * count over the map - so a change far from it never moves it.
 * DO NOT keep the whole sweep again on a global key (the roads' revision, the
 * covers' version): every road drawn and every building grown tested every
 * plant and stone of the map. NOR cap the places kept by a count of the map
 * (FOREST_MAX, SCRUB_MAX, ROCK_MAX before): which ones stood depended on the
 * order of the whole map, and a building grown anywhere moved a stone elsewhere.
 */

/** The places' cells, world units: also the cells their drawing is kept in (`plantCells.ts`). */
export const KEEP_CELL = m(64);
const CELL = KEEP_CELL;
/** A cell's key, from its column and row. */
export const keepCellKey = (i: number, j: number): number => (i + 0x8000) * 0x10000 + (j + 0x8000);
const cellKey = keepCellKey;
/** A key's column and row. */
export const keepCellOf = (key: number): readonly [number, number] => [Math.floor(key / 0x10000) - 0x8000, (key % 0x10000) - 0x8000];

export class CandidateKeep<C extends { readonly x: number; readonly y: number }> {
  /** Per place: 1 standing, 0 not, -1 not tested yet. */
  private readonly standing: Int8Array;
  private readonly ground: Float64Array;
  private readonly cells = new Map<number, number[]>();
  /** The places whose standing or ground changed since the last `takeChanged`; null: every place (a first look). */
  private changedNow: Set<number> | null = null;

  /** `test`: the ground under a place where it may stand, null where it may not. */
  constructor(readonly list: readonly C[], private readonly test: (c: C) => number | null) {
    this.standing = new Int8Array(list.length).fill(-1);
    this.ground = new Float64Array(list.length);
    list.forEach((c, k) => {
      const key = cellKey(Math.floor(c.x / CELL), Math.floor(c.y / CELL));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(k); else this.cells.set(key, [k]);
    });
  }

  /**
   * The places a change reached tested again (`rects`, grown by `pad`: how far
   * round a place its test reads; null: every place). True when what stands
   * changed.
   */
  refresh(rects: readonly ChangeRect[] | null, pad: number): boolean {
    let changed = false;
    const retest = (k: number): void => {
      const z = this.test(this.list[k]!);
      const now = z === null ? 0 : 1;
      if (now !== this.standing[k] || (z !== null && z !== this.ground[k])) { changed = true; this.changedNow?.add(k); }
      this.standing[k] = now;
      if (z !== null) this.ground[k] = z;
    };
    if (rects === null) {
      /** @rebuild Every place: a new sweep, or a change the diary cannot place. */
      for (let k = 0; k < this.list.length; k++) retest(k);
    } else {
      for (const r of rects) {
        const i0 = Math.floor((r[0] - pad) / CELL), i1 = Math.floor((r[2] + pad) / CELL);
        const j0 = Math.floor((r[1] - pad) / CELL), j1 = Math.floor((r[3] + pad) / CELL);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          for (const k of this.cells.get(cellKey(i, j)) ?? []) {
            const c = this.list[k]!;
            if (c.x >= r[0] - pad && c.x <= r[2] + pad && c.y >= r[1] - pad && c.y <= r[3] + pad) retest(k);
          }
        }
      }
    }
    return changed;
  }

  /**
   * The cells whose places changed since the last call, and the call itself the new start; null:
   * every cell (the first call after a sweep). What a drawing kept by cell draws again.
   */
  takeChangedCells(): Set<number> | null {
    const changed = this.changedNow;
    this.changedNow = new Set();
    if (changed === null) return null;
    const out = new Set<number>();
    for (const k of changed) { const c = this.list[k]!; out.add(cellKey(Math.floor(c.x / CELL), Math.floor(c.y / CELL))); }
    return out;
  }

  /** Every cell with a place in it. */
  cellKeys(): IterableIterator<number> {
    return this.cells.keys();
  }

  /** The places standing in a cell, and the ground under each. */
  standingIn(key: number): { readonly c: C; readonly z: number }[] {
    const out: { c: C; z: number }[] = [];
    for (const k of this.cells.get(key) ?? []) if (this.standing[k] === 1) out.push({ c: this.list[k]!, z: this.ground[k]! });
    return out;
  }
}
