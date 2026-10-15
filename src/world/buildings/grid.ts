import type { Aabb } from '@core/aabb';
import { m } from '../units';
import type { BuildingId } from './types';

/**
 * THE BUILDINGS BY PLACE (`BuildingStore.near`): a grid of cells, each
 * holding the buildings whose box (`storedBounds`, with the anchor point)
 * reaches it, kept by the store's own writers - the only ones there are - so
 * it is never out of step (Nystrom, Game Programming Patterns, "Spatial
 * Partition": an object that moves leaves its old cell and enters the new).
 * A question about one place reads a few cells, not the town: every building
 * grown read every building of the town three times over (`zoning.ts`,
 * `validate.ts`), a city of 80 000 buildings 6·10⁹ times.
 *
 * The answer comes in the order of `BuildingStore.all()` (each building keeps
 * the rank it was put in at), so a search that keeps the first of equals
 * finds what the loop over every building found.
 * NÃO voltar a percorrer `buildings.all()` para achar o que está perto.
 */

/** Side of a cell, world units: as wide as the largest of the common buildings. */
const CELL = m(64);
const keyOf = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

interface Placed {
  readonly keys: readonly number[];
  readonly rank: number;
}

/** What the grid files: a building, or what its neighbours read of one (`neighbours.ts`), with its anchor. */
interface Filed {
  readonly id: BuildingId;
  readonly x: number;
  readonly y: number;
}

export class BuildingGrid<T extends Filed> {
  /** Each cell's buildings in the store's order (by rank). */
  private readonly cells = new Map<number, BuildingId[]>();
  private readonly placed = new Map<BuildingId, Placed>();
  private nextRank = 0;

  /**
   * Every building, in the store's order (a load, a clear, a whole store taken over). `boxOf`: its box as
   * the store files it (`storedBounds`), the same for whatever stands in for it, so a grid of neighbours
   * (`editor/growthReplica.ts`) answers as the store's does.
   */
  constructor(all: Iterable<T>, private readonly boxOf: (item: T) => Aabb) {
    for (const b of all) this.insert(b);
  }

  private keysOf(b: T): number[] {
    const box = this.boxOf(b);
    const x0 = Math.min(box.minX, b.x), y0 = Math.min(box.minY, b.y), x1 = Math.max(box.maxX, b.x), y1 = Math.max(box.maxY, b.y);
    const keys: number[] = [];
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) keys.push(keyOf(i, j));
    }
    return keys;
  }

  private file(id: BuildingId, rank: number, keys: readonly number[]): void {
    for (const k of keys) {
      const cell = this.cells.get(k);
      if (!cell) { this.cells.set(k, [id]); continue; }
      // In rank order: a new building is last; one replaced goes back where it stood.
      let at = cell.length;
      while (at > 0 && this.placed.get(cell[at - 1]!)!.rank > rank) at--;
      cell.splice(at, 0, id);
    }
  }

  private unfile(id: BuildingId, keys: readonly number[]): void {
    for (const k of keys) {
      const cell = this.cells.get(k);
      if (!cell) continue;
      const at = cell.indexOf(id);
      if (at >= 0) cell.splice(at, 1);
      if (cell.length === 0) this.cells.delete(k);
    }
  }

  /** A building new to the store: last in its order. */
  insert(b: T): void {
    const keys = this.keysOf(b), rank = this.nextRank++;
    this.placed.set(b.id, { keys, rank });
    this.file(b.id, rank, keys);
  }

  /** A building's record replaced: it keeps its place in the order. */
  update(b: T): void {
    const was = this.placed.get(b.id);
    if (!was) { this.insert(b); return; }
    const keys = this.keysOf(b);
    this.unfile(b.id, was.keys);
    this.placed.set(b.id, { keys, rank: was.rank });
    this.file(b.id, was.rank, keys);
  }

  delete(id: BuildingId): void {
    const was = this.placed.get(id);
    if (!was) return;
    this.unfile(id, was.keys);
    this.placed.delete(id);
  }

  /**
   * The ids of the buildings whose box (or anchor) may reach the rectangle,
   * in the store's order. A superset: the caller keeps its own exact test.
   */
  near(minX: number, minY: number, maxX: number, maxY: number): BuildingId[] {
    const i0 = Math.floor(minX / CELL), i1 = Math.floor(maxX / CELL), j0 = Math.floor(minY / CELL), j1 = Math.floor(maxY / CELL);
    // One cell (the common question): already in order, nothing repeated.
    if (i0 === i1 && j0 === j1) return [...(this.cells.get(keyOf(i0, j0)) ?? [])];
    const found = new Set<BuildingId>();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const id of this.cells.get(keyOf(i, j)) ?? []) found.add(id);
      }
    }
    return [...found].sort((a, b) => this.placed.get(a)!.rank - this.placed.get(b)!.rank);
  }
}
