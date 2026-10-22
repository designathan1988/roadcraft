import type { NetworkBake } from '@world/network';
import type { TrafficBuilding } from '../agents/trafficBuildings';
import type { BakedBays } from '../agents/parking';
import type { TileLinks } from './tileLinks';

/** THE FAR TILES' LINK TABLES, READ BY THE SIMULATION'S WORKER STRAIGHT FROM THE TILE STORE: every stored tile, its table baked where the tile was written (`tileSections.ts`), the page out of the way */

/** DO NOT read a whole tile for one product of it: where a stored tile's sections are read (`tileSections.ts`), each alone - the store's IndexedDB opened in the worker (`tileReader.ts`), or a port to whoever holds it (`simHost.ts`); null: none stored. */
export interface TileReader {
  /** Its meso link table. */
  links(key: number): Promise<TileLinks | null>;
  /** Its buildings as traffic reads them. */
  traffic(key: number): Promise<readonly TrafficBuilding[] | null>;
  /** Its parking bays as baked with it (`tileBays.ts`); null, or no such reader (a port: records only): worked out where the tile is loaded. */
  bays?(key: number): Promise<BakedBays | null>;
  /** Its junctions and ribbons as baked with it (`tileSections.ts` NETWORK_SECTION); null, or no such reader: solved where the tile is loaded. */
  network?(key: number): Promise<NetworkBake | null>;
}


