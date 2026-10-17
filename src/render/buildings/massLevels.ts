import type { CellMass } from './cellArrays';
import type { CellEnv, CellPool } from './cellPool';
import { type CellEntry, sameEntries } from './chunk';
import type { JobKind } from './cellWork';
import { type MassLevel, cellIndex, levelCells, plateOf, tileOf } from './levelKeys';
import { warmFull } from '../uploads';

/** THE BUILDINGS' LEVELS ABOVE THE CELLS: a 1,024 m tile (L2) and a 2,048 m plate (L3) of masses, one mesh each (`massCells.ts` chooses them) */

const KIND: Readonly<Record<MassLevel, JobKind>> = { tile: 'massTile', plate: 'massPlate' };

/** DO NOT ask a tile or a plate again for each cell an edit touched: the cells are touched, their levels asked once (`flush`) */
export class MassLevels {
  /** Each cell's entries as last asked for its masses (`layer.ts` `askMass`): what its tile and plate are made of. */
  private readonly entries = new Map<string, readonly CellEntry[]>();
  private readonly dirty = new Set<string>();
  /** Tiles changed and not asked: no view wants them yet (their plate stands for them, `wanted`). */
  private readonly stale = new Set<string>();
  /** Each level's job asked and not answered. */
  private readonly asked = new Map<string, number>();

  /** `land`: a level's masses come (null: none of its buildings has any); `remove`: a level with no building left; `plan`: a level that has buildings (its place known before its masses);
   *  `wanted`: whether a tile is wanted now (its plate refined for the view) - DO NOT ask every tile of the map: a plate stands for them from afar (Cesium asks a tile's children only when it refines). */
  constructor(private readonly pool: CellPool, private readonly land: (key: string, mass: CellMass | null) => void, private readonly remove: (key: string) => void,
    private readonly plan: (key: string) => void, private readonly wanted: (key: string) => boolean, private readonly rank: (key: string) => number = () => 0) {}

  /** The levels a player's edit changed (`touch` with `edited`): asked first in the queue (`cellPool.ts` EDIT_TIER), once. */
  private readonly edited = new Set<string>();

  /** A cell's buildings asked again (`entries`), or gone (null): its tile and plate to be asked again at `flush`; `edited`, by the player's edit (asked first). */
  touch(cell: string, entries: readonly CellEntry[] | null, edited = false): void {
    const was = this.entries.get(cell);
    // The same buildings on the same ground (the whole town filed again): its levels stand as they are.
    if (was && entries && sameEntries(was, entries)) return;
    if (!was && !entries?.length) return;
    if (entries?.length) this.entries.set(cell, entries); else this.entries.delete(cell);
    const [i, j] = cellIndex(cell);
    this.dirty.add(tileOf(i, j));
    this.dirty.add(plateOf(i, j));
    if (edited) { this.edited.add(tileOf(i, j)); this.edited.add(plateOf(i, j)); }
  }

  /** Every plate touched asked once, made of its cells' entries; a tile touched asked once it is wanted (`pump`); a level with none left removed. */
  flush(env: CellEnv): void {
    for (const key of this.dirty) {
      const list = this.listOf(key);
      if (list.length === 0) {
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.delete(key);
        this.edited.delete(key);
        this.remove(key);
        continue;
      }
      this.plan(key);
      // The upload queue full (`uploads.ts` warmFull): left stale, asked by `pump` once it drains.
      if ((key[0] === 'p' || this.wanted(key)) && (!warmFull(this.rank(key)) || this.edited.has(key))) this.ask(key, list, env);
      else {
        // Its old masses, if any, are no longer its buildings': asked again once a view wants it.
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.add(key);
      }
    }
    this.dirty.clear();
  }

  /** The tiles changed since last asked that a view now wants (a plate refined): asked (each frame, `layer.ts`; as many as tiles changed, never the map). */
  pump(env: CellEnv): void {
    for (const key of this.stale) {
      // DO NOT ask masses to upload while the upload queue is full: their arrays waited on the page (conf77, 2026-10-17); asked once it drains.
      if (warmFull(this.rank(key)) && !this.edited.has(key)) continue;
      if (key[0] !== 'p' && !this.wanted(key)) continue;
      this.stale.delete(key);
      const list = this.listOf(key);
      if (list.length) this.ask(key, list, env);
    }
  }

  /** A tile whose masses were let go, neither drawn nor wanted (`massCells.ts`): asked again once a view wants it (`pump`). */
  release(key: string): void {
    if (key[0] === 't' && this.listOf(key).length) this.stale.add(key);
  }

  /** A level's buildings, its cells' in order. */
  private listOf(key: string): CellEntry[] {
    const { i0, j0, n } = levelCells(key);
    const list: CellEntry[] = [];
    for (let i = i0; i < i0 + n; i++) {
      for (let j = j0; j < j0 + n; j++) {
        const some = this.entries.get(`${i},${j}`);
        if (some) for (const e of some) list.push(e);
      }
    }
    return list;
  }

  /** A level asked of the workers, the older ask of it cancelled. */
  private ask(key: string, list: readonly CellEntry[], env: CellEnv): void {
    const was = this.asked.get(key);
    if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
    const kind = KIND[levelCells(key).level];
    // DO NOT read `id` in the answer before it is given: on the page the answer comes inside `run`.
    let id = -1;
    const edited = this.edited.delete(key);
    id = this.pool.run(kind, key, list, env, (result) => {
      if (this.asked.get(key) === id) this.asked.delete(key);
      this.land(key, result.mass ?? null);
    }, `${kind}|${key}`, edited);
    if (this.pool.isRunning(id)) this.asked.set(key, id);
  }

  /** Whether a level's buildings changed since its masses were made (asked and not come, or not asked yet): its mesh, if any, is of older buildings. */
  outdated(key: string): boolean {
    return this.asked.has(key) || this.stale.has(key) || this.dirty.has(key);
  }

  /** Levels asked and not come. */
  get asking(): number {
    return this.asked.size;
  }

  /** Every request cancelled and every cell forgotten (a context restored, the layer gone): the next filing touches them all again. */
  clear(): void {
    for (const id of this.asked.values()) this.pool.cancel(id);
    this.asked.clear();
    this.entries.clear();
    this.dirty.clear();
    this.stale.clear();
    this.edited.clear();
  }
}
