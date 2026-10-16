import { packArrays, packedArray, packedNumber, unpackArrays } from '@core/arrayPack';
import { migrateBuilding } from '@world/buildings/serialize';
import type { TileRecords } from '@world/doc';
import { type TrafficBuilding, trafficBuilding } from './agents/trafficBuildings';
import { TILE_LINKS_FORMAT, type TileLinks, bakeTileLinks } from './meso/tileLinks';
import { BAYS_SECTION, bakeTileBays } from './tileBays';

/** THE TILE'S SECTIONS THE SIMULATION READS (CLAUDE.md "Streaming world"): its meso link table, its buildings as traffic reads them and its parking bays (`tileBays.ts`), baked once where the tile is written (the generator's worker, the save worker: `editor/tileStore.ts` TileBaker) and stored with it; the simulation's worker reads each alone, never the whole tile */

/** The link table, a typed-array pack (`core/arrayPack.ts`). */
export const LINKS_SECTION = 'links';
/** The buildings as traffic reads them (`trafficBuilding`), JSON. */
export const TRAFFIC_SECTION = 'traffic';
/** Bumped when what the traffic section holds or how `trafficBuilding` works it out changes: an older one is derived again from the records. */
const TRAFFIC_FORMAT = 1;

/** A section as the tile store keeps it (`editor/tileStore.ts` TileSection, the same shape: the simulation does not import the editor). */
type Section = { readonly json: unknown } | { readonly bin: Uint8Array<ArrayBuffer> };

/** The link table's arrays as they are packed. */
const LINK_ARRAYS = [
  'link', 'from', 'to', 'length', 'lanes', 'vFree', 'capacity', 'flags', 'shape', 'turnStart', 'turnTo', 'turnWeight', 'nodes', 'nodeFlags', 'nodeDegree', 'cells',
] as const satisfies readonly (keyof TileLinks)[];

/** A link table as one buffer. */
function packLinks(links: TileLinks): Uint8Array<ArrayBuffer> {
  const arrays: Record<string, TileLinks[(typeof LINK_ARRAYS)[number]]> = {};
  for (const name of LINK_ARRAYS) arrays[name] = links[name];
  return packArrays({ key: links.key, version: links.version, format: links.format, count: links.count }, arrays);
}

/** A link table read back from its buffer, its arrays views on it; null: of another format than this build bakes (derived again). */
export function unpackLinks(buffer: ArrayBuffer): TileLinks | null {
  const pack = unpackArrays(buffer);
  if (packedNumber(pack, 'format') !== TILE_LINKS_FORMAT) return null;
  return {
    key: packedNumber(pack, 'key'), version: packedNumber(pack, 'version'), format: TILE_LINKS_FORMAT, count: packedNumber(pack, 'count'),
    link: packedArray(pack, 'link', Float64Array), from: packedArray(pack, 'from', Float64Array), to: packedArray(pack, 'to', Float64Array),
    length: packedArray(pack, 'length', Float32Array), lanes: packedArray(pack, 'lanes', Uint8Array), vFree: packedArray(pack, 'vFree', Float32Array),
    capacity: packedArray(pack, 'capacity', Float32Array), flags: packedArray(pack, 'flags', Uint8Array), shape: packedArray(pack, 'shape', Float32Array),
    turnStart: packedArray(pack, 'turnStart', Uint32Array), turnTo: packedArray(pack, 'turnTo', Uint32Array), turnWeight: packedArray(pack, 'turnWeight', Float32Array),
    nodes: packedArray(pack, 'nodes', Float64Array), nodeFlags: packedArray(pack, 'nodeFlags', Uint8Array), nodeDegree: packedArray(pack, 'nodeDegree', Uint16Array),
    cells: packedArray(pack, 'cells', Float64Array),
  };
}

/** A tile's buildings as traffic reads them: each record read by the document's own reader, those it cannot read left out (as `BuildingStore.load`). */
export function tileTraffic(buildings: readonly unknown[]): TrafficBuilding[] {
  const out: TrafficBuilding[] = [];
  for (const raw of buildings) {
    const b = migrateBuilding(raw);
    if (b) out.push(trafficBuilding(b));
  }
  return out;
}

/** The traffic section as JSON: an empty building's box is infinite (`buildingBounds`), and JSON has no Infinity (it writes null). */
function trafficJson(list: readonly TrafficBuilding[]): unknown {
  return { format: TRAFFIC_FORMAT, buildings: list };
}

type Box = TrafficBuilding['bounds'];
/** A box read back: a null side the infinity it was (an empty box runs from +Infinity to -Infinity). */
const boxBack = (b: { readonly minX: number | null; readonly minY: number | null; readonly maxX: number | null; readonly maxY: number | null }): Box => ({
  minX: b.minX ?? Infinity, minY: b.minY ?? Infinity, maxX: b.maxX ?? -Infinity, maxY: b.maxY ?? -Infinity,
});

/** The traffic section read back; null: of another format than this build bakes (derived again). */
export function trafficOfSection(value: unknown): TrafficBuilding[] | null {
  const v = value as { format?: unknown; buildings?: unknown } | null;
  if (!v || v.format !== TRAFFIC_FORMAT || !Array.isArray(v.buildings)) return null;
  return (v.buildings as TrafficBuilding[]).map((t) => ({ ...t, bounds: boxBack(t.bounds), reach: boxBack(t.reach) }));
}

/** DO NOT derive these again where the tile is read: baked here once per version of the tile, where it is written */
export function bakeTileSections(records: TileRecords): Readonly<Record<string, Section>> {
  const traffic = trafficJson(tileTraffic(records.buildings));
  const sections: Record<string, Section> = {
    [LINKS_SECTION]: { bin: packLinks(bakeTileLinks(records)) },
    [TRAFFIC_SECTION]: { json: traffic },
  };
  try {
    // From the buildings as the simulation reads them back (the JSON's numbers: no -0, no Infinity), so their digests are the ones it makes there.
    sections[BAYS_SECTION] = { bin: bakeTileBays(records, trafficOfSection(JSON.parse(JSON.stringify(traffic)))!) };
  } catch (error) {
    // Stored without them: the simulation works them out where the tile is loaded, as before.
    console.error(`[save] tile ${records.key}'s bays could not be baked`, error);
  }
  return sections;
}
