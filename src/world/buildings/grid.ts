import type { Aabb } from '@core/aabb';
import { m } from '../units';
import type { BuildingId } from './types';

/** THE BUILDINGS BY PLACE (`BuildingStore.near`): a grid of cells, each holding the buildings whose box */

/** Side of a cell, world units: as wide as the largest of the common buildings. */
const CELL = m(64);
const keyOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);
/** A rank and an id packed in one number (`BuildingGrid.inOrder`): ids below 2^32, ranks below 2^20, the two within a double's 53 exact bits. */
const PACKED_IDS = 2 ** 32;
const PACKED_RANKS = 2 ** 20;

/** Where a building is filed: its rank in the store's order, then the columns and rows of the cells its box reaches (`PLACED_*`). DO NOT keep its cells' keys as a list and an object round them (~260 B a building, 2026-10-21): five small integers in one list. */
type Placed = readonly number[];
const PLACED_RANK = 0, PLACED_I0 = 1, PLACED_I1 = 2, PLACED_J0 = 3, PLACED_J1 = 4;

/** Calls `visit` with the key of every cell a building's place reaches, columns outer, rows inner. */
function forKeys(placed: Placed, visit: (key: number) => void): void {
  for (let i = placed[PLACED_I0]!; i <= placed[PLACED_I1]!; i++) {
    for (let j = placed[PLACED_J0]!; j <= placed[PLACED_J1]!; j++) visit(keyOf(i, j));
  }
}

/** What the grid files: a building, or what its neighbours read of one (`neighbours.ts`), with its anchor. */
interface Filed {
  readonly id: BuildingId;
  readonly x: number;
  readonly y: number;
}

export class BuildingGrid<T extends Filed> {
  /** Each cell's buildings in the store's order (by rank); over another grid (`over`), the cells written here (an empty one hides the base's). */
  private readonly cells = new Map<number, BuildingId[]>();
  private readonly placed = new Map<BuildingId, Placed>();
  private nextRank = 0;
  /** The grid this one lies over (`over`): read through for every cell and building not written here. */
  private base: BuildingGrid<T> | null = null;
  /** The base's buildings deleted here. */
  private readonly gone = new Set<BuildingId>();

  /** Every building, in the store's order (a load, a clear, a whole store taken over). `boxOf`: its box as the store files it (`storedBounds`), the same for whatever stands in for it, so a grid of neighbours (`editor/growthReplica.ts`) answers as the store's does. */
  constructor(all: Iterable<T>, private readonly boxOf: (item: T) => Aabb) {
    for (const b of all) this.insert(b);
  }

  /** DO NOT file a working copy's whole map again at its first write (`BuildingStore.forkFrom`): 10-40 ms a commit that writes buildings and then asks by place. A grid over `base`, answering as one made of the copy's buildings would: a cell is copied here when first written, the rest read through. `base` must not change while this one is used. */
  static over<T extends Filed>(base: BuildingGrid<T>): BuildingGrid<T> {
    const grid = new BuildingGrid<T>([], base.boxOf);
    grid.base = base;
    grid.nextRank = base.nextRank;
    return grid;
  }

  private cellAt(k: number): readonly BuildingId[] | undefined {
    const own = this.cells.get(k);
    return own ?? this.base?.cellAt(k);
  }

  /** A cell to write: the base's copied here first. */
  private ownCell(k: number): BuildingId[] | undefined {
    const own = this.cells.get(k);
    if (own || !this.base) return own;
    const below = this.base.cellAt(k);
    if (!below) return undefined;
    const copy = below.slice();
    this.cells.set(k, copy);
    return copy;
  }

  private placedOf(id: BuildingId): Placed | undefined {
    return this.placed.get(id) ?? (this.base && !this.gone.has(id) ? this.base.placedOf(id) : undefined);
  }

  /** Where `b` is filed at `rank`: the cells its box (and its anchor) reach. */
  private placeOf(b: T, rank: number): Placed {
    const box = this.boxOf(b);
    const x0 = Math.min(box.minX, b.x), y0 = Math.min(box.minY, b.y), x1 = Math.max(box.maxX, b.x), y1 = Math.max(box.maxY, b.y);
    return [rank, Math.floor(x0 / CELL), Math.floor(x1 / CELL), Math.floor(y0 / CELL), Math.floor(y1 / CELL)];
  }

  private file(id: BuildingId, placed: Placed): void {
    const rank = placed[PLACED_RANK]!;
    forKeys(placed, (k) => {
      const cell = this.ownCell(k);
      if (!cell) { this.cells.set(k, [id]); return; }
      // In rank order: a new building is last; one replaced goes back where it stood.
      let at = cell.length;
      while (at > 0 && this.placedOf(cell[at - 1]!)![PLACED_RANK]! > rank) at--;
      cell.splice(at, 0, id);
    });
  }

  private unfile(id: BuildingId, placed: Placed): void {
    forKeys(placed, (k) => {
      const cell = this.ownCell(k);
      if (!cell) return;
      const at = cell.indexOf(id);
      if (at >= 0) cell.splice(at, 1);
      // Over a base, an empty cell stays: it hides the base's.
      if (cell.length === 0 && !this.base) this.cells.delete(k);
    });
  }

  /** A building new to the store: last in its order. */
  insert(b: T): void {
    const placed = this.placeOf(b, this.nextRank++);
    this.gone.delete(b.id);
    this.placed.set(b.id, placed);
    this.file(b.id, placed);
  }

  /** A building's record replaced: it keeps its place in the order. */
  update(b: T): void {
    const was = this.placedOf(b.id);
    if (!was) { this.insert(b); return; }
    const placed = this.placeOf(b, was[PLACED_RANK]!);
    this.unfile(b.id, was);
    this.placed.set(b.id, placed);
    this.file(b.id, placed);
  }

  delete(id: BuildingId): void {
    const was = this.placedOf(id);
    if (!was) return;
    this.unfile(id, was);
    this.placed.delete(id);
    if (this.base) this.gone.add(id);
  }

  /** The ids of the buildings whose box (or anchor) may reach the rectangle, in the store's order. */
  near(minX: number, minY: number, maxX: number, maxY: number): BuildingId[] {
    const i0 = Math.floor(minX / CELL), i1 = Math.floor(maxX / CELL), j0 = Math.floor(minY / CELL), j1 = Math.floor(maxY / CELL);
    // One cell (the common question): already in order, nothing repeated.
    if (i0 === i1 && j0 === j1) return [...(this.cellAt(keyOf(i0, j0)) ?? [])];
    const found = new Set<BuildingId>();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const id of this.cellAt(keyOf(i, j)) ?? []) found.add(id);
      }
    }
    return this.inOrder(found);
  }

  /** Ids in the store's order (by rank, each rank one building's) */
  private inOrder(ids: Set<BuildingId>): BuildingId[] {
    // DO NOT sort by a comparator reading two ranks from the map at each comparison: the growth asks 200 m round every lot (`LIKE_REACH`), a hundred buildings and more sorted each time. Each rank and its id packed in one number (rank above, id below) sorted as numbers: the same order, ranks being distinct.
    const keys = new Float64Array(ids.size);
    let k = 0;
    for (const id of ids) {
      const rank = this.placedOf(id)![PLACED_RANK]!;
      if (rank >= PACKED_RANKS || id < 0 || id >= PACKED_IDS || !Number.isInteger(id)) {
        return [...ids].sort((a, b) => this.placedOf(a)![PLACED_RANK]! - this.placedOf(b)![PLACED_RANK]!);
      }
      keys[k++] = rank * PACKED_IDS + id;
    }
    keys.sort();
    const out = new Array<BuildingId>(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = (keys[i]! % PACKED_IDS) as BuildingId;
    return out;
  }

  /** DO NOT ask `near` rectangle by rectangle for many */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (id: BuildingId, rect: readonly [number, number, number, number]) => boolean): BuildingId[] {
    const over = new Map<number, (readonly [number, number, number, number])[]>();
    for (const r of rects) {
      const i0 = Math.floor((r[0] - pad) / CELL), i1 = Math.floor((r[2] + pad) / CELL);
      const j0 = Math.floor((r[1] - pad) / CELL), j1 = Math.floor((r[3] + pad) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = keyOf(i, j);
          if (!this.cellAt(k)?.length) continue;
          const list = over.get(k);
          if (list) list.push(r); else over.set(k, [r]);
        }
      }
    }
    const kept = new Set<BuildingId>();
    for (const [k, list] of over) {
      for (const id of this.cellAt(k)!) {
        if (kept.has(id)) continue;
        for (const r of list) if (meets(id, r)) { kept.add(id); break; }
      }
    }
    return this.inOrder(kept);
  }
}
