/** THE KEYS OF THE BUILDINGS' CELLS AND LEVELS: a cell "i,j", a 1,024 m tile "t:x,y" and a 2,048 m plate "p:x,y" (`massLevels.ts`, `massCells.ts`, `cellPool.ts`); imports nothing, so each reads them without the others */

/** Cells a tile and a plate are on a side (`world/cells.ts` CELL, 256 m: 1,024 m and 2,048 m, `bounds.ts` PLATE_SIZE). */
export const TILE_CELLS = 4;
const PLATE_CELLS = 8;
/** The plates sit half a plate off the cells' origin: the map's middle plate is centred on it (`bounds.ts`); each holds four whole tiles. */
const PLATE_SHIFT = PLATE_CELLS / 2;

export type MassLevel = 'tile' | 'plate';

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
