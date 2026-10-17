import { type StoredPart, type TilePartName, readTile, readTilePart, readTileSection } from '@editor/tileStore';
import { tileBuildingsOf, withGrownBuildings } from '@world/growth/grownRows';
import { portParts, workerParts } from '@editor/workerParts';
import type { TileRecords } from '@world/doc';
import type { TileReader } from '@sim/meso/tileFeed';
import { bakeTileLinks } from '@sim/meso/tileLinks';
import { LINKS_SECTION, TRAFFIC_SECTION, tileTraffic, trafficOfSection, unpackLinks } from '@sim/tileSections';
import { BAYS_SECTION, unpackTileBays } from '@sim/tileBays';

/** The tile store's tiles read where they are asked (the simulation's worker, the job workers' far bakes): its IndexedDB opened read only there, the page out of the way, and each product's own part read alone (`editor/tileStore.ts` layout) */

/** A reader of the store's tiles in a worker: the simulation's sections, and the records' parts the far bakes read. */
export interface StoredTileReader extends TileReader {
  /** A part of the records as an object of its fields (the roads: nodes, borrowed nodes, segments; the buildings); null: none stored. */
  part(key: number, name: TilePartName): Promise<Partial<TileRecords> | null>;
}

/** The fields of the records a part holds. */
const PART_FIELDS: Readonly<Record<TilePartName, readonly (keyof TileRecords)[]>> = {
  roads: ['nodes', 'borrowedNodes', 'segments', 'gates'],
  buildings: ['buildings', 'grown', 'lots'],
};

/** `port`: the desktop's saves writer, a port of this worker's own (`desktopSaves.ts` `connect`); none: this worker's store (`workerParts`). */
export function storeTileReader(map: string, port?: MessagePort | null): StoredTileReader {
  const store = port ? portParts(port) : workerParts();
  /** A tile stored with no such part, or with one of another format: its records, to derive it from here (format 1 is written again in parts by the save worker the next time the page asks for the tile, `TileStore`). */
  const recordsOf = (key: number, got: NonNullable<StoredPart>): Promise<TileRecords | null> =>
    ('records' in got ? Promise.resolve(got.records) : readTile(store, map, key));
  return {
    async links(key) {
      const got = await readTilePart(store, map, key, LINKS_SECTION);
      if (!got) return null;
      const links = 'bytes' in got ? unpackLinks(got.bytes) : null;
      if (links) return links;
      const records = await recordsOf(key, got);
      return records ? bakeTileLinks(withGrownBuildings(records)) : null;
    },
    async traffic(key) {
      const got = await readTilePart(store, map, key, TRAFFIC_SECTION);
      if (!got) return null;
      const traffic = 'value' in got ? trafficOfSection(got.value) : null;
      if (traffic) return traffic;
      const records = await recordsOf(key, got);
      return records ? tileTraffic(tileBuildingsOf(records)) : null;
    },
    async bays(key) {
      // DO NOT bake them here from the records of a tile stored without them (a network, its lanes and every lot's grid on the simulation's thread): the simulation works them out as it always did.
      const got = await readTileSection(store, map, key, BAYS_SECTION);
      return got && 'bytes' in got ? unpackTileBays(got.bytes) : null;
    },
    async part(key, name) {
      const got = await readTilePart(store, map, key, name);
      if (!got) return null;
      if ('value' in got) return got.value as Partial<TileRecords>;
      const records = await recordsOf(key, got);
      if (!records) return null;
      const out: Record<string, unknown> = {};
      for (const field of PART_FIELDS[name]) out[field] = records[field];
      return out as Partial<TileRecords>;
    },
  };
}
