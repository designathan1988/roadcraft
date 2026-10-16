import { storedTileReader } from '@core/storedTiles';
import type { TileRecords } from '@world/doc';
import { TILE } from '@world/tiles';

/** THE FAR LEVELS' QUADTREE OVER THE TILES (`farTiles.ts`, `farPlan.ts`, `../farTree.ts`): its nodes' keys and sides and a tile as a bake reads it, read by the bakes of the tiles and of the plan without either importing the other */

/** The coarsest level: 2^7 tiles a side (131 km); a bigger world has more roots. */
export const TOP_LEVEL = 7;
/** Squares a side a box level merges its small boxes in: its error is one square's diagonal (`levelDrop`). */
export const AGGREGATE = 128;

/** A node's key: its level and its column and row at that level ("f2:-1,3"). */
export const farKey = (k: number, i: number, j: number): string => `f${k}:${i},${j}`;

/** A node's level, column and row from its key. */
export function farNode(key: string): { readonly k: number; readonly i: number; readonly j: number } {
  const colon = key.indexOf(':'), comma = key.indexOf(',');
  return { k: Number(key.slice(1, colon)), i: Number(key.slice(colon + 1, comma)), j: Number(key.slice(comma + 1)) };
}

/** A node's side, m: a tile's at level 0, doubled each level up. */
export const nodeSide = (k: number): number => TILE * 2 ** k;

/** A tile's records with nothing in them (a tile the store no longer has): baked as empty, so its parents are not held waiting. */
export function emptyRecords(key: number, version: number): TileRecords {
  return {
    key, version, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: 0, segment: 0, pole: 0, span: 0, building: 0, lot: 0, landscape: 0, barrier: 0 },
  };
}

/** DO NOT read a whole tile for a bake that reads one part of it: the part alone (its roads, its buildings), the other lists left empty
 *  - read from the store by this worker (`core/storedTiles.ts`); undefined where it cannot read it (the page asked for it), empty when the store no longer has it. */
export async function readStored(store: string | undefined, key: number, part: 'roads' | 'buildings'): Promise<TileRecords | undefined> {
  const read = store === undefined ? null : storedTileReader();
  if (!read || store === undefined) return undefined;
  const fields = await read(store, key, part) as Partial<TileRecords> | null;
  return { ...emptyRecords(key, 0), ...(fields ?? {}) };
}
