import { readTile } from '@editor/tileStore';
import { SAVES_STORE, indexedDbParts, openSaves } from '@editor/saveStore';
import type { TileReader } from '@sim/meso/tileFeed';

/** The tile store's tiles read where they are asked (the simulation's worker): its IndexedDB opened read only there, the page out of the way (`editor/tileStore.ts` layout). */
export function storeTileReader(map: string): TileReader {
  const store = indexedDbParts(openSaves, SAVES_STORE);
  return { read: (key) => readTile(store, map, key) };
}
