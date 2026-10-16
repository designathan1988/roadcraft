import type { ChangeRect } from './changes';
import type { SerializedDoc } from './doc';
import type { Lot } from './lots';
import { m } from './units';

/** THE WORLD'S TILES: an unbounded grid of 1,024 m squares, the unit the world is generated, kept, loaded and drawn by (CLAUDE.md, "Streaming world") */

/** A tile's side. The tiles' edges lie on multiples of it, so a tile nests in a 2,048 m plate (`bounds.ts`) and holds 16 cells of 256 m. */
export const TILE = m(1_024);

/** Tiles each way from the origin a key can name (2^15): about 33,000 km, far past any map, so a key and an id stay exact doubles. */
const TILE_REACH = 1 << 15;

/** A tile's column and row. */
export interface TileIJ {
  readonly i: number;
  readonly j: number;
}

/** The tile a point lies in: a point on an edge is the tile's whose low edge it is. */
export const tileIJ = (x: number, y: number): TileIJ => ({ i: Math.floor(x / TILE), j: Math.floor(y / TILE) });

/** A tile's key: its column and row packed in one number (each shifted to be positive, 16 bits each). */
export function tileKey(i: number, j: number): number {
  if (i < -TILE_REACH || i >= TILE_REACH || j < -TILE_REACH || j >= TILE_REACH) throw new Error(`tile ${i},${j} is past the world's reach`);
  return (i + TILE_REACH) * (TILE_REACH * 2) + (j + TILE_REACH);
}

/** The column and row of a tile's key. */
export function tileOfKey(key: number): TileIJ {
  const side = TILE_REACH * 2;
  return { i: Math.floor(key / side) - TILE_REACH, j: (key % side) - TILE_REACH };
}

/** The key of the tile a point lies in. */
export const tileKeyAt = (x: number, y: number): number => {
  const { i, j } = tileIJ(x, y);
  return tileKey(i, j);
};

/** A tile's square as a diary rectangle (`changes.ts`): what a load or an unload of it reaches. */
export const tileRect = (i: number, j: number): ChangeRect => [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE];

/** The ids a tile hands out: each tile its own range, so a tile is made, kept and loaded alone and two tiles never name one record alike */
export const TILE_IDS = 1 << 20;

/** The first id of a tile's range; the ids under `TILE_IDS` are a map's from before the tiles (kept as they were, never handed out again). */
export const tileIdBase = (key: number): number => (key + 1) * TILE_IDS;

/** The ids a tile counts out one by one (its own records); the upper half of its range is its edge's nodes' (`edgeNodeId`). */
export const TILE_COUNTED = 1 << 19;

/** Steps an edge node's place is told in along its edge: a centimetre (an edge is 102,400 of them, under 2^17). */
const EDGE_STEP = m(0.01);

/** A node on a tile's edge: the same id from both tiles that lay it (each makes it alone, from the seed and the place, `cityGen/wholeMap.ts`)
 *  - a point on a tile edge belongs to the tile whose low edge it is (`tileIJ`); its id is told by which of that tile's two low edges it is on and how far along. Null off any edge. */
export function edgeNodeId(x: number, y: number): number | null {
  const { i, j } = tileIJ(x, y);
  const onX = x === i * TILE, onY = y === j * TILE;
  if (!onX && !onY) return null;
  // The corner counts as the x edge's (offset 0 along it).
  const along = onX ? y - j * TILE : x - i * TILE;
  const step = Math.round(along / EDGE_STEP);
  return tileIdBase(tileKey(i, j)) + TILE_COUNTED + (onX ? 0 : 1 << 17) + step;
}

/** The tiles within `radius` tiles of the tile at (`i`, `j`), the nearest first (a square ring by ring). */
export function tilesAround(i: number, j: number, radius: number): TileIJ[] {
  const out: TileIJ[] = [{ i, j }];
  for (let r = 1; r <= radius; r++) {
    for (let di = -r; di <= r; di++) {
      out.push({ i: i + di, j: j - r }, { i: i + di, j: j + r });
    }
    for (let dj = -r + 1; dj <= r - 1; dj++) {
      out.push({ i: i - r, j: j + dj }, { i: i + r, j: j + dj });
    }
  }
  return out;
}

/** Which tile a record belongs to: every record to one tile only, by the point that files it */
export const OWNER = {
  /** A node: where it stands. */
  node: (n: { readonly x: number; readonly y: number }): number => tileKeyAt(n.x, n.y),
  /** A road: the tile of the middle of its ends (a border avenue on the edge: the tile whose low edge it is; a street crossing an edge: the side it mostly lies on); an end in another tile is kept with it as a borrowed node. */
  segment: (a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number => tileKeyAt((a.x + b.x) / 2, (a.y + b.y) / 2),
  /** A span: the tile of the middle of its poles, as a road's (its other pole, if across an edge, borrowed). */
  span: (a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number => tileKeyAt((a.x + b.x) / 2, (a.y + b.y) / 2),
  /** A building or a lot, a pole, a tree, a dab, an item: its anchor. */
  at: (p: { readonly x: number; readonly y: number }): number => tileKeyAt(p.x, p.y),
} as const;

/** A tile as the store keeps it (`TileStore`): the records it owns, as a saved map holds them, and the ends of its roads and spans that are its neighbours' */
export interface TileRecords {
  readonly key: number;
  /** Written again at each change of the tile (the store's), for what is baked from it (far levels, link tables) to know it is stale. */
  readonly version: number;
  readonly nodes: SerializedDoc['nodes'];
  /** The nodes of other tiles its roads end on, as they were when written: put in the document only while their own tile is not. */
  readonly borrowedNodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  readonly poles: NonNullable<SerializedDoc['poles']>;
  readonly borrowedPoles: NonNullable<SerializedDoc['poles']>;
  readonly poleSpans: NonNullable<SerializedDoc['poleSpans']>;
  readonly buildings: readonly unknown[];
  readonly lots: readonly Lot[];
  readonly lotKeys: readonly string[];
  readonly landscape: NonNullable<SerializedDoc['landscape']>;
  readonly barriers: NonNullable<SerializedDoc['barriers']>;
  readonly paint: NonNullable<SerializedDoc['paint']>;
  readonly trees: NonNullable<SerializedDoc['trees']>;
  readonly elements: NonNullable<SerializedDoc['elements']>;
  /** The next id each kind counts out in the tile's range (`TILE_COUNTED`), from `tileIdBase`. */
  readonly next: Readonly<Record<'node' | 'segment' | 'pole' | 'span' | 'building' | 'lot' | 'landscape' | 'barrier', number>>;
}
