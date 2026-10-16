import type { CellMass } from './cellArrays';
import type { CellEnv, CellPool } from './cellPool';
import { sameEntries } from './cellRequests';
import type { CellEntry, JobKind } from './cellWork';

/** THE BUILDINGS' LEVELS ABOVE THE CELLS: a 1,024 m tile (L2) and a 2,048 m plate (L3) of masses, one mesh each (`massCells.ts` chooses them) */

/** Cells a tile and a plate are on a side (`world/cells.ts` CELL, 256 m: 1,024 m and 2,048 m, `bounds.ts` PLATE_SIZE). */
export const TILE_CELLS = 4;
const PLATE_CELLS = 8;
/** The plates sit half a plate off the cells' origin: the map's middle plate is centred on it (`bounds.ts`); each holds four whole tiles. */
const PLATE_SHIFT = PLATE_CELLS / 2;

type MassLevel = 'tile' | 'plate';

/** The tile and the plate a cell (column, row) lies in, as keys ("t:x,y", "p:x,y"). */
export const tileOf = (i: number, j: number): string => `t:${Math.floor(i / TILE_CELLS)},${Math.floor(j / TILE_CELLS)}`;
export const plateOf = (i: number, j: number): string => `p:${Math.floor((i + PLATE_SHIFT) / PLATE_CELLS)},${Math.floor((j + PLATE_SHIFT) / PLATE_CELLS)}`;

/** A cell's column and row from its key ("i,j", `layer.ts` `cellOf`). */
export function cellIndex(key: string): readonly [number, number] {
  const comma = key.indexOf(',');
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

/** The cells a level's key covers: its first column and row and its side, in cells. */
export function levelCells(key: string): { readonly level: MassLevel; readonly i0: number; readonly j0: number; readonly n: number } {
  const comma = key.indexOf(',');
  const a = Number(key.slice(2, comma)), b = Number(key.slice(comma + 1));
  return key[0] === 't'
    ? { level: 'tile', i0: a * TILE_CELLS, j0: b * TILE_CELLS, n: TILE_CELLS }
    : { level: 'plate', i0: a * PLATE_CELLS - PLATE_SHIFT, j0: b * PLATE_CELLS - PLATE_SHIFT, n: PLATE_CELLS };
}

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
    private readonly plan: (key: string) => void, private readonly wanted: (key: string) => boolean) {}

  /** A cell's buildings asked again (`entries`), or gone (null): its tile and plate to be asked again at `flush`. */
  touch(cell: string, entries: readonly CellEntry[] | null): void {
    const was = this.entries.get(cell);
    // The same buildings on the same ground (the whole town filed again): its levels stand as they are.
    if (was && entries && sameEntries(was, entries)) return;
    if (!was && !entries?.length) return;
    if (entries?.length) this.entries.set(cell, entries); else this.entries.delete(cell);
    const [i, j] = cellIndex(cell);
    this.dirty.add(tileOf(i, j));
    this.dirty.add(plateOf(i, j));
  }

  /** Every plate touched asked once, made of its cells' entries; a tile touched asked once it is wanted (`pump`); a level with none left removed. */
  flush(env: CellEnv): void {
    for (const key of this.dirty) {
      const list = this.listOf(key);
      if (list.length === 0) {
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.delete(key);
        this.remove(key);
        continue;
      }
      this.plan(key);
      if (key[0] === 'p' || this.wanted(key)) this.ask(key, list, env);
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
      if (!this.wanted(key)) continue;
      this.stale.delete(key);
      const list = this.listOf(key);
      if (list.length) this.ask(key, list, env);
    }
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
    id = this.pool.run(kind, key, list, env, (result) => {
      if (this.asked.get(key) === id) this.asked.delete(key);
      this.land(key, result.mass ?? null);
    }, `${kind}|${key}`);
    if (this.pool.isRunning(id)) this.asked.set(key, id);
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
  }
}
