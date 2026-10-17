import { packArrays, packArraysBlob, packedArray, packedNumber, unpackArrays } from '@core/arrayPack';
import { migrateBuilding } from '@world/buildings/serialize';
import type { TileRecords } from '@world/doc';
import { type TrafficBuilding, trafficBuilding } from './agents/trafficBuildings';
import { TILE_LINKS_FORMAT, type TileLinks, bakeTileLinks } from './meso/tileLinks';
import { BAYS_SECTION, bakeTileBays } from './tileBays';
import type { NetworkBake } from '@world/network';
import { tileNetworkBake } from '@world/tileNetwork';

/** THE TILE'S SECTIONS THE SIMULATION READS (CLAUDE.md "Streaming world"): its meso link table, its buildings as traffic reads them and its parking bays (`tileBays.ts`), baked once where the tile is written (the generator's worker, the save worker: `editor/tileStore.ts` TileBaker) and stored with it; the simulation's worker reads each alone, never the whole tile */

/** The link table, a typed-array pack (`core/arrayPack.ts`). */
export const LINKS_SECTION = 'links';
/** The buildings as traffic reads them (`trafficBuilding`), JSON. */
export const TRAFFIC_SECTION = 'traffic';
/** Bumped when what the traffic section holds or how `trafficBuilding` works it out changes: an older one is derived again from the records. */
const TRAFFIC_FORMAT = 1;

/** A section as the tile store keeps it (`editor/tileStore.ts` TileSection, the same shape: the simulation does not import the editor). */
type Section = { readonly json: unknown } | { readonly bin: Uint8Array<ArrayBuffer> } | { readonly blob: Blob };

/** The link table's arrays as they are packed. */
const LINK_ARRAYS = [
  'link', 'from', 'to', 'length', 'lanes', 'vFree', 'capacity', 'flags', 'shape', 'turnStart', 'turnTo', 'turnWeight', 'nodes', 'nodeFlags', 'nodeDegree', 'cells',
] as const satisfies readonly (keyof TileLinks)[];

/** A link table's numbers and arrays as they are packed. */
function linkPack(links: TileLinks): [Readonly<Record<string, number>>, Readonly<Record<string, TileLinks[(typeof LINK_ARRAYS)[number]]>>] {
  const arrays: Record<string, TileLinks[(typeof LINK_ARRAYS)[number]]> = {};
  for (const name of LINK_ARRAYS) arrays[name] = links[name];
  return [{ key: links.key, version: links.version, format: links.format, count: links.count }, arrays];
}

/** A link table as one buffer. */
export function packLinks(links: TileLinks): Uint8Array<ArrayBuffer> {
  return packArrays(...linkPack(links));
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

/** The tile's junctions and ribbons solved from its roads (`tileNetworkBake`): the simulation's worker reads them from the store, never from the page. */
export const NETWORK_SECTION = 'network';
/** Bumped when the bake's shape changes (`world/networkBuild.ts` NetworkBake): an older one is not read. */
const NETWORK_FORMAT = 1;
/** The tags of what JSON cannot say as itself: a Map, a Float64Array, a number that is not finite or is -0, an undefined. */
const MAP_TAG = '\u0000m', F64_TAG = '\u0000f', NUM_TAG = '\u0000n', UNDEF_TAG = '\u0000u';

/** A value as JSON can hold it, the bake's own kinds tagged (`plainOf`); DO NOT use it for anything holding other classes (thrown). */
function taggedOf(value: unknown): unknown {
  if (value === undefined) return { [UNDEF_TAG]: 1 };
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { [NUM_TAG]: Object.is(value, -0) ? '-0' : String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) return { [MAP_TAG]: [...value].map(([k, v]) => [taggedOf(k), taggedOf(v)]) };
  if (value instanceof Float64Array) return { [F64_TAG]: Array.from(value, taggedOf) };
  if (Array.isArray(value)) return value.map(taggedOf);
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new Error(`a ${(value as object).constructor?.name ?? 'value'} cannot be kept as a section`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = taggedOf(v);
  return out;
}

/** A value read back from its tagged JSON (`taggedOf`). */
function plainOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plainOf);
  const o = value as Record<string, unknown>;
  if (UNDEF_TAG in o) return undefined;
  if (NUM_TAG in o) return o[NUM_TAG] === '-0' ? -0 : Number(o[NUM_TAG]);
  if (MAP_TAG in o) return new Map((o[MAP_TAG] as [unknown, unknown][]).map(([k, v]) => [plainOf(k), plainOf(v)]));
  if (F64_TAG in o) return Float64Array.from(o[F64_TAG] as unknown[], (x) => plainOf(x) as number);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = plainOf(v);
  return out;
}

/** The network section of a tile: its bake, tagged. */
export function tileNetworkSection(bake: NetworkBake): Section {
  return { json: { format: NETWORK_FORMAT, bake: taggedOf(bake) } };
}

/** The network section read back; null: of another format (the junctions are solved where the tile is loaded). */
export function networkOfSection(value: unknown): NetworkBake | null {
  const v = value as { format?: unknown; bake?: unknown } | null;
  return v && v.format === NETWORK_FORMAT ? plainOf(v.bake) as NetworkBake : null;
}

/** DO NOT derive these again where the tile is read: baked here once per version of the tile, where it is written
 *  - `bays`: false for a tile made ahead of the region (the opening's rush): its bays and its network are baked and added later (`tileBaysSection`, `tileNetworkSection`, `cityTile.worker.ts`). */
export function bakeTileSections(records: TileRecords, bays = true): Readonly<Record<string, Section>> {
  const traffic = trafficJson(tileTraffic(records.buildings));
  const sections: Record<string, Section> = {
    // Straight into the part's Blob (`packArraysBlob`), the same bytes as `packLinks`: no buffer of its own beside it.
    [LINKS_SECTION]: { blob: packArraysBlob(...linkPack(bakeTileLinks(records))) },
    [TRAFFIC_SECTION]: { json: traffic },
  };
  const baked = bays ? tileBaysSection(records, traffic) : null;
  if (baked) sections[BAYS_SECTION] = baked;
  // A tile of the region (or written by an edit): its junctions too, for the simulation's worker; a tile made ahead takes them when it is loaded (`cityTile.worker.ts`).
  if (bays) sections[NETWORK_SECTION] = tileNetworkSection(tileNetworkBake(records));
  return sections;
}

/** A tile's bays section, from its records (every building, the grown rows made again) and its traffic section's value; null when they could not be baked (said, and worked out where the tile is loaded). */
export function tileBaysSection(records: TileRecords, traffic: unknown): Section | null {
  try {
    // From the buildings as the simulation reads them back (the JSON's numbers: no -0, no Infinity), so their digests are the ones it makes there.
    const read = trafficOfSection(JSON.parse(JSON.stringify(traffic)));
    if (!read) return null;
    return { bin: bakeTileBays(records, read) };
  } catch (error) {
    // Stored without them: the simulation works them out where the tile is loaded, as before.
    console.error(`[save] tile ${records.key}'s bays could not be baked`, error);
    return null;
  }
}
