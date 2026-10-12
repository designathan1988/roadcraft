import { TILE_COUNT, TILE_HALF, TILES_PER_SIDE } from '@core/planetTiles';
import type { Vec2 } from '@core/vec2';
import { m } from '../units';

/**
 * THE PLANET'S ATLAS: the sphere is the world, and every point of it is
 * written on the map of the piece that owns it (`core/planetTiles.ts`): one
 * exact, reversible code for a point of the sphere. The pieces' maps are laid
 * side by side on one plane only as an address book - each cell of the plane
 * is one piece's map, and neighbours on the sphere need not be neighbours here.
 *
 * The maps are the charts of an atlas of OVERLAPPING charts (a manifold's
 * atlas, its transition maps through the sphere): what is worked out for a
 * piece is worked out on its map with everything within `TILE_REACH` of it
 * brought onto that map, so nothing is ever cut at a border.
 *
 * `3 x TILES_PER_SIDE` pieces a row, `2 x TILES_PER_SIDE` rows,
 * `ATLAS_PITCH` between centres: the gutter round a piece holds what reaches
 * past its border. Every centre on a multiple of `ATLAS_GRID` (160 m), so the
 * terrain's 6.4 m cells, the grid's 10 m and the plants' 5 m fall on the same
 * lines in every piece.
 */

/** The grid the pieces' centres sit on, and their pitch is a multiple of. */
export const ATLAS_GRID = m(160);
/** The planet terrain's cell (`render/terrain.ts`): 25 to the atlas grid, 6.4 m. */
export const PLATE_CELL = ATLAS_GRID / 25;

/** How far past its border what a piece owns may reach, and what round it is brought onto its map (a junction's plate, a building, a road's neighbours). */
export const TILE_REACH = m(120);
/** Centre to centre of two pieces side by side in the atlas, world units: room for a piece and its reach both sides, on the atlas grid. */
export const ATLAS_PITCH = Math.ceil((2 * (TILE_HALF + TILE_REACH) + m(80)) / ATLAS_GRID) * ATLAS_GRID;
/** Pieces a row in the atlas. */
export const ATLAS_COLUMNS = 3 * TILES_PER_SIDE;
/** Rows of pieces in the atlas. */
export const ATLAS_ROWS = TILE_COUNT / ATLAS_COLUMNS;
const COLUMN_OFFSET = ATLAS_COLUMNS / 2;
const ROW_OFFSET = ATLAS_ROWS / 2;

const centres: readonly Readonly<Vec2>[] = Array.from({ length: TILE_COUNT }, (_, t) => Object.freeze({
  x: ((t % ATLAS_COLUMNS) - COLUMN_OFFSET) * ATLAS_PITCH,
  y: (Math.floor(t / ATLAS_COLUMNS) - ROW_OFFSET) * ATLAS_PITCH,
}));

/** A piece's centre in the atlas. */
export const tileCentre = (tile: number): Readonly<Vec2> => centres[tile] as Vec2;

/** The piece whose cell of the atlas holds a point: the nearest centre's. */
export function tileCellOf(x: number, y: number): number {
  const col = Math.min(ATLAS_COLUMNS - 1, Math.max(0, Math.round(x / ATLAS_PITCH) + COLUMN_OFFSET));
  const row = Math.min(ATLAS_ROWS - 1, Math.max(0, Math.round(y / ATLAS_PITCH) + ROW_OFFSET));
  return row * ATLAS_COLUMNS + col;
}

/** A point of the atlas in its piece's own map: about the piece's centre. */
export interface TileLocal {
  tile: number;
  x: number;
  y: number;
}

/** A point of the atlas as its piece's map point, into `out`. */
export function atlasToTileInto(x: number, y: number, out: TileLocal): TileLocal {
  const tile = tileCellOf(x, y);
  const c = centres[tile] as Vec2;
  out.tile = tile;
  out.x = x - c.x;
  out.y = y - c.y;
  return out;
}

/** A piece's map point in the atlas. */
export const tileToAtlas = (tile: number, x: number, y: number): Vec2 => {
  const c = centres[tile] as Vec2;
  return { x: c.x + x, y: c.y + y };
};

/** Half the square about a piece's centre its ground is laid on (the terrain's plate): a cell over `TILE_HALF`, on the terrain's grid. */
export const TILE_PLATE_HALF = Math.ceil(TILE_HALF / PLATE_CELL) * PLATE_CELL;
