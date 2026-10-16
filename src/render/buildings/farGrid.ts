import { TILE } from '@world/tiles';

/** THE FAR LEVELS' QUADTREE OVER THE TILES (`farTiles.ts`, `farPlan.ts`, `../farTree.ts`): its nodes' keys and sides alone, read by the bakes of the tiles and of the plan without either importing the other */

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
